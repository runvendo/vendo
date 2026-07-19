import { VendoError, type VendoErrorCode } from "@vendoai/core";
// execution-v2 transition: cloudSandbox still speaks the archived v1 seam
// end-to-end (console wire included); the Wave 5 Cloud lane ports it to the
// v2 seam. Until then it rides the deprecated compat surface.
import type { V1SandboxAdapter, V1SandboxMachine } from "@vendoai/apps";
import { deploymentIdentityHeaders } from "./deployment-identity.js";

/** The console mounts the managed-sandbox surface here
 * (apps/console/app/api/v1/sandboxes/*). */
const CONSOLE_SANDBOX_PATH = "/api/v1/sandboxes";

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

/** The Cloud sandbox adapter — the OSS side of the managed-sandbox seam: a
 * plain SandboxAdapter speaking HTTP to the console's /api/v1/sandboxes
 * routes (Vendo's pooled provider capacity, metered as sandbox_minutes).
 * Cloned from cloudConnections' shape: behavior comes ONLY from constructor
 * arguments (adapter rule — see selectSandbox in server.ts); the adapter
 * never reads the environment. */
export function cloudSandbox(options: CloudSandboxOptions): V1SandboxAdapter {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const send = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const response = await fetchImpl(`${base}${CONSOLE_SANDBOX_PATH}${path}`, {
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

  const wrap = (handle: { id: string; url: string }): V1SandboxMachine => {
    const prefix = `/${encodeURIComponent(handle.id)}`;
    return {
      id: handle.id,
      async request(req) {
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
      async exec(cmd, execOptions) {
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
        async read(path) {
          const response = await send(`${prefix}/files?path=${encodeURIComponent(path)}`);
          return new Uint8Array(await response.arrayBuffer());
        },
        async write(path, bytes) {
          await send(`${prefix}/files?path=${encodeURIComponent(path)}`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: toArrayBuffer(toBytes(bytes)),
          });
        },
        async list(dir) {
          const payload = await sendJson(`${prefix}/files/list?dir=${encodeURIComponent(dir)}`, "GET") as { entries?: unknown };
          return Array.isArray(payload.entries)
            ? payload.entries.filter((entry): entry is string => typeof entry === "string")
            : [];
        },
      },
      async snapshot() {
        const payload = await sendJson(`${prefix}/snapshot`, "POST") as { ref?: unknown };
        if (typeof payload.ref !== "string" || payload.ref.length === 0) {
          throw new VendoError("sandbox-unavailable", "Vendo Cloud sandbox returned no snapshot reference");
        }
        return payload.ref;
      },
      async screenshot() {
        const response = await send(`${prefix}/screenshot`);
        return new Uint8Array(await response.arrayBuffer());
      },
      async url(_port) {
        // The Cloud data plane serves the app's $PORT on the machine host; the
        // handle URL from create/resume IS the rung-4 serving origin.
        return handle.url;
      },
      async stop() {
        await sendJson(prefix, "DELETE");
      },
    };
  };

  const parseHandle = (payload: unknown): { id: string; url: string } => {
    const handle = payload as { id?: unknown; url?: unknown };
    if (typeof handle.id !== "string" || typeof handle.url !== "string") {
      throw new VendoError("sandbox-unavailable", "Vendo Cloud sandbox returned no machine handle");
    }
    return { id: handle.id, url: handle.url };
  };

  return {
    async create(spec) {
      let files: Record<string, string> | undefined;
      if (spec.files !== undefined) {
        files = {};
        for (const [path, data] of Object.entries(spec.files)) {
          files[path] = encodeBase64(toBytes(data));
        }
      }
      return wrap(parseHandle(await sendJson("", "POST", {
        env: spec.env,
        ...(files === undefined ? {} : { files }),
        ...(spec.egress === undefined ? {} : { egress: [...spec.egress] }),
      })));
    },
    async resume(snapshotRef) {
      return wrap(parseHandle(await sendJson("/resume", "POST", { ref: snapshotRef })));
    },
  };
}
