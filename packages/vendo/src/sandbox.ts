import type { SandboxAdapter, SandboxMachine, SandboxResumePolicy } from "@vendoai/apps";
import { VendoError, type VendoErrorCode } from "@vendoai/core";
import { deploymentIdentityHeaders } from "./deployment-identity.js";
import { CLOUD_BOX_PORT, CLOUD_SANDBOX_PATH, CLOUD_SNAPSHOT_REF_PREFIX } from "./sandbox-wire.js";

/** Console error codes forwarded as-is when they are wire-legal VendoError
 * codes (same posture as the apps block's cloud share/publish client). The
 * console's "unavailable"/"quota-exhausted" have no VendoError twin; they fall
 * to sandbox-unavailable and the 402 → cloud-required mapping respectively. */
const CLOUD_ERROR_CODES: ReadonlySet<string> = new Set([
  "validation",
  "blocked",
  "not-implemented",
  "cloud-required",
  "not-found",
  "conflict",
] satisfies VendoErrorCode[]);

/** Same default as the e2b adapter and the retired ENG-295 broker client:
 * generous enough for a slow machine boot, small enough that a hung console
 * request can't wedge a generation forever. */
const DEFAULT_TIMEOUT_MS = 300_000;

export interface CloudSandboxOptions {
  apiKey: string;
  /** Defaults to the Vendo console; the composition seam passes VENDO_CLOUD_URL. */
  baseUrl?: string;
  /** Per-request abort timeout, in milliseconds. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const encoder = new TextEncoder();

const toBytes = (data: Uint8Array | string): Uint8Array =>
  typeof data === "string" ? encoder.encode(data) : data;

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => value.slice().buffer as ArrayBuffer;

/** btoa/atob-based codecs (the console speaks base64 JSON envelopes); chunked
 * like the console's own encoder, and Buffer-free so the umbrella's server
 * surface keeps loading on edge/Worker targets. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    // Console garbage is the SERVICE misbehaving, never the caller's fault —
    // same posture as every malformed-success branch below.
    throw new VendoError("sandbox-unavailable", "Vendo Cloud sandbox returned invalid base64 content");
  }
}

async function raiseCloudError(response: Response): Promise<never> {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    payload = undefined;
  }
  const error = typeof payload === "object" && payload !== null && "error" in payload
    ? (payload as { error?: { code?: unknown; message?: unknown } }).error
    : undefined;
  const message = typeof error?.message === "string"
    ? error.message
    : `Vendo Cloud sandbox request failed with ${response.status}`;
  // The console's meter gate (quota-exhausted) rides HTTP 402 — the one
  // "pay/upgrade to proceed" signal, same mapping as cloudConnections. 401
  // (bad/revoked key) is the same "fix your Cloud standing" story for the
  // host operator, so it keeps the ENG-295 client's cloud-required mapping —
  // with the server's own message preserved.
  if (response.status === 402 || response.status === 401) {
    throw new VendoError("cloud-required", message);
  }
  const code = typeof error?.code === "string" && CLOUD_ERROR_CODES.has(error.code)
    ? (error.code as VendoErrorCode)
    : "sandbox-unavailable";
  throw new VendoError(code, message);
}

/** Seam contract: refs are provider-prefixed opaque strings; a ref this
 * provider did not issue must reject without touching the console. */
const assertCloudRef = (snapshotRef: string): void => {
  if (!snapshotRef.startsWith(CLOUD_SNAPSHOT_REF_PREFIX)
    || snapshotRef.length <= CLOUD_SNAPSHOT_REF_PREFIX.length) {
    throw new VendoError(
      "validation",
      `Vendo Cloud snapshot references must start with "${CLOUD_SNAPSHOT_REF_PREFIX}"`,
    );
  }
};

/** True exactly for the "that state is already gone" answer that the seam's
 * idempotent transitions (destroy twice, stop of a dead machine) absorb. */
const isGone = (error: unknown): boolean =>
  error instanceof VendoError && error.code === "not-found";

/** The Cloud sandbox adapter — the OSS side of the managed-sandbox seam: the
 * execution-v2 SandboxAdapter speaking HTTP to the console's /api/v1/sandboxes
 * routes (Vendo's pooled provider capacity, metered as sandbox_minutes). The
 * wire contract lives in sandbox-wire.ts. Cloned from cloudConnections' shape:
 * behavior comes ONLY from constructor arguments (adapter rule — see
 * selectSandbox in server.ts); the adapter never reads the environment.
 *
 * Provider particulars, versus the e2b reference port:
 * - Single port: the Cloud relay and the public ingress
 *   (`https://<id>.m.vendo.run`) serve exactly {@link CLOUD_BOX_PORT}; a
 *   non-default `request.port` raises the typed `cloud-single-port` error
 *   (code "not-implemented", `detail.reason = "cloud-single-port"`).
 * - No pause: `stop()` mints a best-effort preservation snapshot and then
 *   deletes the machine, so sleeping never silently discards state the
 *   caller hadn't snapshotted (see the stop entry in sandbox-wire.ts).
 * - Refs are minted server-side and opaque past the `vendo:` prefix; resume
 *   applies SandboxResumePolicy as the wire's three-state egress override.
 *
 * The machine object also carries adapter-private exec/files/url used for
 * live-lane bootstrap and diagnostics — NOT part of the public seam (the
 * in-box agent owns the inside of the box). */
export function cloudSandbox(options: CloudSandboxOptions): SandboxAdapter {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const send = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const response = await fetchImpl(`${base}${CLOUD_SANDBOX_PATH}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: "application/json",
        // Interaction model: key-authed Cloud requests carry the deployment
        // identity; the console meters usage from real traffic.
        ...(await deploymentIdentityHeaders()),
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) await raiseCloudError(response);
    return response;
  };

  const sendJson = async (path: string, method: string, body?: unknown): Promise<unknown> => {
    const response = await send(path, {
      method,
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    try {
      return await response.json();
    } catch {
      return {};
    }
  };

  const parseHandle = (payload: unknown): { id: string; url: string } => {
    const handle = payload as { id?: unknown; url?: unknown };
    if (typeof handle.id !== "string" || typeof handle.url !== "string") {
      throw new VendoError("sandbox-unavailable", "Vendo Cloud sandbox returned no machine handle");
    }
    return { id: handle.id, url: handle.url };
  };

  const wrap = (handle: { id: string; url: string }): SandboxMachine => {
    const prefix = `/${encodeURIComponent(handle.id)}`;
    const takeSnapshot = async (): Promise<string> => {
      const payload = await sendJson(`${prefix}/snapshot`, "POST") as { ref?: unknown };
      if (typeof payload.ref !== "string" || payload.ref.length === 0) {
        throw new VendoError("sandbox-unavailable", "Vendo Cloud sandbox returned no snapshot reference");
      }
      // A ref this adapter would itself refuse to resume/destroy must never
      // reach a document — reject it as console garbage here instead.
      if (!payload.ref.startsWith(CLOUD_SNAPSHOT_REF_PREFIX)) {
        throw new VendoError("sandbox-unavailable", `Vendo Cloud sandbox returned a foreign snapshot reference (expected the "${CLOUD_SNAPSHOT_REF_PREFIX}" prefix)`);
      }
      return payload.ref;
    };
    const remove = async (): Promise<void> => {
      try {
        await sendJson(prefix, "DELETE");
      } catch (error) {
        if (!isGone(error)) throw error;
      }
    };
    // Seam rule: sleeping or destroying twice is not an error, and destroy is
    // final. The one-shot promises make that hold under concurrency too —
    // each transition is assigned synchronously, so racing callers share one
    // console call chain, and a destroy during an in-flight stop serializes
    // after it (e2b-adapter pattern).
    let sleeping: Promise<void> | undefined;
    let destroying: Promise<void> | undefined;

    return {
      id: handle.id,
      async request(req) {
        if (req.port !== undefined && req.port !== CLOUD_BOX_PORT) {
          // The Cloud relay is HARDWIRED to the one box port (the e2b adapter
          // keeps multi-port); erroring beats silently answering from a port
          // the caller didn't ask for.
          throw new VendoError(
            "not-implemented",
            `Vendo Cloud sandboxes serve a single box port (${CLOUD_BOX_PORT}); request.port=${req.port} cannot be routed (cloud-single-port)`,
            { reason: "cloud-single-port", port: req.port },
          );
        }
        const payload = await sendJson(`${prefix}/request`, "POST", {
          method: req.method,
          path: req.path.startsWith("/") ? req.path : `/${req.path}`,
          ...(req.headers === undefined ? {} : { headers: req.headers }),
          ...(req.body === undefined ? {} : { body_b64: encodeBase64(toBytes(req.body)) }),
        }) as { status?: unknown; headers?: unknown; body_b64?: unknown };
        if (typeof payload.status !== "number" || typeof payload.body_b64 !== "string") {
          throw new VendoError("sandbox-unavailable", "Vendo Cloud sandbox returned an invalid proxy response");
        }
        const headers = typeof payload.headers === "object" && payload.headers !== null
          ? Object.fromEntries(Object.entries(payload.headers)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string"))
          : {};
        return { status: payload.status, headers, body: decodeBase64(payload.body_b64) };
      },
      async snapshot() {
        return takeSnapshot();
      },
      async stop() {
        if (destroying !== undefined) {
          await destroying;
          return;
        }
        // Defensive Cloud sleep (wire contract: no pause endpoint exists):
        // mint a preservation snapshot so post-snapshot state survives the
        // delete, then drop the machine. The preservation ref is discarded —
        // the sleep flows that need a ref mint their own BEFORE stopping
        // (machine-lifecycle.ts) — and the mint is best-effort: a machine the
        // Cloud sweeper already reaped has nothing left to preserve.
        sleeping ??= takeSnapshot()
          .then(() => undefined, (error) => {
            if (!isGone(error)) throw error;
          })
          .then(remove);
        await sleeping;
      },
      async destroy() {
        destroying ??= (sleeping ?? Promise.resolve())
          .catch(() => undefined)
          .then(remove);
        await destroying;
      },
      // ——— adapter-private below this line (live-lane bootstrap + diagnostics) ———
      async exec(cmd: string, execOptions?: { cwd?: string; timeoutMs?: number }) {
        const payload = await sendJson(`${prefix}/exec`, "POST", {
          cmd,
          ...(execOptions?.cwd === undefined ? {} : { cwd: execOptions.cwd }),
          ...(execOptions?.timeoutMs === undefined ? {} : { timeout_ms: execOptions.timeoutMs }),
        }) as { code?: unknown; stdout?: unknown; stderr?: unknown };
        if (typeof payload.code !== "number") {
          throw new VendoError("sandbox-unavailable", "Vendo Cloud sandbox returned an invalid exec response");
        }
        return {
          code: payload.code,
          stdout: typeof payload.stdout === "string" ? payload.stdout : "",
          stderr: typeof payload.stderr === "string" ? payload.stderr : "",
        };
      },
      files: {
        async read(path: string) {
          const response = await send(`${prefix}/files?path=${encodeURIComponent(path)}`);
          return new Uint8Array(await response.arrayBuffer());
        },
        async write(path: string, bytes: Uint8Array | string) {
          await send(`${prefix}/files?path=${encodeURIComponent(path)}`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: toArrayBuffer(toBytes(bytes)),
          });
        },
        async list(dir: string) {
          const payload = await sendJson(`${prefix}/files/list?dir=${encodeURIComponent(dir)}`, "GET") as { entries?: unknown };
          return Array.isArray(payload.entries)
            ? payload.entries.filter((entry): entry is string => typeof entry === "string")
            : [];
        },
      },
      async url(_port: number) {
        // The Cloud data plane serves the box port on the public ingress; the
        // handle URL from create/resume IS the layer-3 serving origin.
        return handle.url;
      },
    } satisfies SandboxMachine & Record<string, unknown> as SandboxMachine;
  };

  return {
    async create(spec) {
      return wrap(parseHandle(await sendJson("", "POST", {
        env: spec.env,
        ...(spec.template === undefined ? {} : { template: spec.template }),
        // Seam semantics carried verbatim: absent = unrestricted, [] = deny-all
        // (deny-by-default lives ABOVE the seam — Lane E's grant flow).
        ...(spec.allowedDomains === undefined ? {} : { egress: [...spec.allowedDomains] }),
      })));
    },
    async resume(snapshotRef, policy?: SandboxResumePolicy) {
      assertCloudRef(snapshotRef);
      return wrap(parseHandle(await sendJson("/resume", "POST", {
        ref: snapshotRef,
        // Lane E — a wake enforces the CURRENT egress policy when the caller
        // passes one; the wire keeps "no override" (field absent) distinct
        // from "override to unrestricted" (explicit null).
        ...(policy === undefined ? {} : {
          egress: policy.allowedDomains === undefined ? null : [...policy.allowedDomains],
        }),
      })));
    },
    async destroy(snapshotRef) {
      assertCloudRef(snapshotRef);
      try {
        await sendJson(`/${encodeURIComponent(snapshotRef)}`, "DELETE");
      } catch (error) {
        // Idempotent by seam contract: already-deleted state is a no-op.
        if (!isGone(error)) throw error;
      }
    },
  };
}
