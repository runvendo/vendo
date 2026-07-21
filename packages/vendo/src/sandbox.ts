import type { SandboxAdapter, SandboxMachine, SandboxResumePolicy } from "@vendoai/apps";
import { VendoError, type VendoErrorCode } from "@vendoai/core";
import { deploymentIdentityHeaders } from "./deployment-identity.js";
import {
  CLOUD_BOX_PORT,
  CLOUD_SANDBOX_PATH,
  CLOUD_SNAPSHOT_REF_PREFIX,
  CLOUD_SNAPSHOTS_SUBPATH,
  CONSOLE_SNAPSHOT_REF_PREFIX,
} from "./sandbox-wire.js";

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
const decoder = new TextDecoder();

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

/** The adapter-minted composite snapshot ref payload (sandbox-wire.ts): the
 * console ref alone cannot serve the seam — destroy-by-ref needs the machine
 * id (the console DELETE route is machine-only), a bare resume re-applies the
 * snapshot-time allowlist, and url() needs the app's $PORT. */
interface CloudSnapshotState {
  version: 2;
  machineId: string;
  /** The console-minted ref (`vendo:snap_<40hex>`), sent back on resume. */
  ref: string;
  allowedDomains?: string[];
  /** The app's $PORT at snapshot time; the canonical box port when absent. */
  port?: number;
}

const parsePort = (env: Record<string, string>): number => {
  const port = Number(env.PORT ?? CLOUD_BOX_PORT);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : CLOUD_BOX_PORT;
};

const toBase64Url = (value: string): string =>
  encodeBase64(encoder.encode(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const encodeSnapshotRef = (state: CloudSnapshotState): string =>
  `${CLOUD_SNAPSHOT_REF_PREFIX}${toBase64Url(JSON.stringify(state))}`;

const decodeSnapshotRef = (snapshotRef: string): CloudSnapshotState => {
  try {
    if (!snapshotRef.startsWith(CLOUD_SNAPSHOT_REF_PREFIX)
      || snapshotRef.length <= CLOUD_SNAPSHOT_REF_PREFIX.length) {
      throw new Error("unknown prefix");
    }
    const payload = snapshotRef.slice(CLOUD_SNAPSHOT_REF_PREFIX.length)
      .replaceAll("-", "+").replaceAll("_", "/");
    const state = JSON.parse(decoder.decode(
      Uint8Array.from(atob(payload), (character) => character.charCodeAt(0)),
    )) as Record<string, unknown>;
    if (state.version !== 2
      || typeof state.machineId !== "string" || state.machineId.length === 0
      || typeof state.ref !== "string" || !state.ref.startsWith(CONSOLE_SNAPSHOT_REF_PREFIX)) {
      throw new Error("invalid payload");
    }
    if (state.allowedDomains !== undefined && !(Array.isArray(state.allowedDomains)
      && state.allowedDomains.every((host) => typeof host === "string"))) {
      throw new Error("invalid allowedDomains policy");
    }
    if (state.port !== undefined && !(Number.isInteger(state.port)
      && (state.port as number) > 0 && (state.port as number) <= 65_535)) {
      throw new Error("invalid port");
    }
    return {
      version: 2,
      machineId: state.machineId,
      ref: state.ref,
      ...(state.allowedDomains === undefined ? {} : { allowedDomains: [...state.allowedDomains as string[]] }),
      ...(state.port === undefined ? {} : { port: state.port as number }),
    };
  } catch {
    throw new VendoError(
      "validation",
      `Vendo Cloud snapshot references must start with "${CLOUD_SNAPSHOT_REF_PREFIX}" and carry a valid payload`,
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
 * wire contract — the ARTIFACT model, verified live — lives in
 * sandbox-wire.ts. Cloned from cloudConnections' shape: behavior comes ONLY
 * from constructor arguments (adapter rule — see selectSandbox in server.ts);
 * the adapter never reads the environment.
 *
 * Provider particulars, versus the e2b reference port:
 * - Snapshots are persistent artifacts that survive the machine; resume
 *   boots a NEW machine from one (fork when the source lives, wake when it
 *   is gone) and inherits NO network config, so every resume sends the
 *   applicable allowlist explicitly — the ref-recorded one bare, the
 *   caller's SandboxResumePolicy when a wake re-polices (Lane E replace
 *   semantics, native on the wire).
 * - stop() destroys the machine: Cloud has no pause, and with artifacts
 *   surviving it, snapshot-then-destroy IS the sleep semantics; previously
 *   minted refs stay valid through it (the seam law).
 * - Composite refs: the seam sees `vendo:v2:<base64url state>` carrying the
 *   console artifact ref, the source machine id (destroy-by-ref reaps a
 *   still-running source best-effort before the artifact GC), and the
 *   snapshot-time allowlist a bare resume re-applies.
 * - `spec.template` is dropped from the wire: the create route takes none —
 *   the pooled base image (Node + the in-box agent) is Cloud's own.
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

  const wrap = (
    handle: { id: string; url: string },
    state: { allowedDomains?: string[] | undefined; port: number },
  ): SandboxMachine => {
    const prefix = `/${encodeURIComponent(handle.id)}`;
    /** POST /{id}/snapshot — mint a persistent artifact; the source keeps running. */
    const mintArtifact = async (): Promise<string> => {
      const payload = await sendJson(`${prefix}/snapshot`, "POST") as { ref?: unknown };
      if (typeof payload.ref !== "string" || payload.ref.length === 0) {
        throw new VendoError("sandbox-unavailable", "Vendo Cloud sandbox returned no snapshot reference");
      }
      // A ref this adapter would itself refuse to carry must never reach a
      // document — reject it as console garbage here instead.
      if (!payload.ref.startsWith(CONSOLE_SNAPSHOT_REF_PREFIX)
        || payload.ref.length <= CONSOLE_SNAPSHOT_REF_PREFIX.length) {
        throw new VendoError("sandbox-unavailable", `Vendo Cloud sandbox returned a foreign snapshot reference (expected the "${CONSOLE_SNAPSHOT_REF_PREFIX}" prefix)`);
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
        let payload: unknown;
        try {
          payload = await sendJson(`${prefix}/request`, "POST", {
            method: req.method,
            path: req.path.startsWith("/") ? req.path : `/${req.path}`,
            // Absent port targets the canonical box port server-side; explicit
            // ports (e.g. the in-box agent control port) route as-is.
            ...(req.port === undefined ? {} : { port: req.port }),
            ...(req.headers === undefined ? {} : { headers: req.headers }),
            ...(req.body === undefined ? {} : { body_b64: encodeBase64(toBytes(req.body)) }),
          });
        } catch (error) {
          // Wave 7 — the seam's dead-machine signal. Cloud stop is final (no
          // pause), so a conflict ("Sandbox is stopped") on the DATA path
          // means the sweep destroyed the machine out from under this handle,
          // exactly like a purged id's not-found: both become the thrown
          // not-found the lifecycle's eviction/re-wake recovery keys on.
          if (error instanceof VendoError && error.code === "conflict") {
            throw new VendoError("not-found", `Vendo Cloud sandbox ${handle.id} is gone (destroyed by the provider): ${error.message}`);
          }
          throw error;
        }
        const proxied = payload as { status?: unknown; headers?: unknown; body_b64?: unknown };
        if (typeof proxied.status !== "number" || typeof proxied.body_b64 !== "string") {
          throw new VendoError("sandbox-unavailable", "Vendo Cloud sandbox returned an invalid proxy response");
        }
        const headers = typeof proxied.headers === "object" && proxied.headers !== null
          ? Object.fromEntries(Object.entries(proxied.headers)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string"))
          : {};
        return { status: proxied.status, headers, body: decodeBase64(proxied.body_b64) };
      },
      async snapshot() {
        // A checkpoint through a machine object that already slept or was
        // destroyed is a caller bug — say so crisply instead of relaying
        // whatever the console answers for the dead machine.
        if (sleeping !== undefined || destroying !== undefined) {
          throw new VendoError("conflict", "the machine is asleep or destroyed; resume its snapshot ref instead of checkpointing it");
        }
        return encodeSnapshotRef({
          version: 2,
          machineId: handle.id,
          ref: await mintArtifact(),
          ...(state.allowedDomains === undefined ? {} : { allowedDomains: [...state.allowedDomains] }),
          port: state.port,
        });
      },
      async stop() {
        if (destroying !== undefined) {
          await destroying;
          return;
        }
        // Cloud sleep IS destruction: there is no pause, and snapshot
        // artifacts survive the machine — the sleep flows mint their ref
        // BEFORE stopping (machine-lifecycle.ts) and wake by resuming it.
        sleeping ??= remove();
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
      async url(port?: number) {
        // Wave 4 (layer 3) — the browser→box serving path. The handle URL
        // from create/resume IS the canonical-port ingress: single-label
        // `<id-suffix>-m.vendo.run` as shipped by the console (vendo-web
        // #85; -m is a SUFFIX because Cloudflare routes only allow leading
        // wildcards, `*-m.vendo.run/*`). Other ports insert before the
        // suffix — `<id-suffix>-<port>-m.vendo.run` — matching the
        // machine-proxy parse (sandbox-wire.ts ingress entry). Hosts
        // without a -m label (custom consoles) keep the e2b-style prefix.
        const target = port ?? state.port;
        if (target === CLOUD_BOX_PORT) return handle.url;
        const ingress = new URL(handle.url);
        const suffixed = /^(.+)-m(\..+)$/.exec(ingress.host);
        ingress.host = suffixed === null
          ? `${target}-${ingress.host}`
          : `${suffixed[1]}-${target}-m${suffixed[2]}`;
        return ingress.origin;
      },
    } satisfies SandboxMachine & Record<string, unknown> as SandboxMachine;
  };

  return {
    async create(spec) {
      // spec.template is dropped: the create route takes none — the pooled
      // base image (Node + the in-box agent harness) is Cloud's own
      // (sandbox-wire.ts).
      return wrap(parseHandle(await sendJson("", "POST", {
        env: spec.env,
        // Seam semantics carried verbatim: absent = unrestricted, [] = deny-all
        // (deny-by-default lives ABOVE the seam — Lane E's grant flow).
        ...(spec.allowedDomains === undefined ? {} : { egress: [...spec.allowedDomains] }),
        // Defensive copy: later refs must record the policy the machine was
        // CREATED with, immune to caller-side mutation of the array.
      })), {
        allowedDomains: spec.allowedDomains === undefined ? undefined : [...spec.allowedDomains],
        port: parsePort(spec.env),
      });
    },
    async resume(snapshotRef, policy?: SandboxResumePolicy) {
      const state = decodeSnapshotRef(snapshotRef);
      // The new machine inherits NO network config from the artifact
      // (sandbox-wire.ts), so every resume states the applicable allowlist:
      // Lane E's replace semantics when the caller re-polices the wake, the
      // ref-recorded snapshot-time policy otherwise. undefined stays the
      // seam's "unrestricted" (absent field on the wire).
      const allowedDomains = policy === undefined ? state.allowedDomains : policy.allowedDomains;
      return wrap(parseHandle(await sendJson("/resume", "POST", {
        ref: state.ref,
        ...(allowedDomains === undefined ? {} : { egress: [...allowedDomains] }),
      })), {
        allowedDomains: allowedDomains === undefined ? undefined : [...allowedDomains],
        port: state.port ?? CLOUD_BOX_PORT,
      });
    },
    async destroy(snapshotRef) {
      const state = decodeSnapshotRef(snapshotRef);
      // Best-effort reap of the recorded source machine (it is usually
      // already gone — the sleep flow destroyed it), then the artifact GC.
      // A 404 from either is the seam's idempotent no-op.
      await sendJson(`/${encodeURIComponent(state.machineId)}`, "DELETE").catch(() => undefined);
      try {
        await sendJson(`${CLOUD_SNAPSHOTS_SUBPATH}/${encodeURIComponent(state.ref)}`, "DELETE");
      } catch (error) {
        if (!isGone(error)) throw error;
      }
    },
  };
}
