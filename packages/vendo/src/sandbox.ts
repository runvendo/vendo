import { VendoError } from "@vendoai/core";
import { consoleSender, raiseCloudError, toArrayBuffer } from "./cloud-console.js";

// ─── Wave-5 port pending ────────────────────────────────────────────────────
// execution-v2: cloudSandbox still speaks the archived v1 seam end-to-end
// (console wire included); the Wave 5 Cloud lane ports it (and the console's
// /api/v1/sandboxes routes) to the v2 seam. The shared sandbox-v1-compat
// bridge died in Wave 1.5, so the MINIMAL v1 shapes live here, file-local and
// deprecated — nothing else may import them, and they are deleted with the
// Wave 5 port. Until then this adapter satisfies no runtime slot: the umbrella
// wires machine execution only for a v2 adapter (see selectSandbox/server.ts).

/** @deprecated archived v1 create spec (docs/archive/contracts/06-apps.md §3) — Wave 5 deletes this. */
interface V1SandboxCreateSpec {
  env: Record<string, string>;
  files?: Record<string, Uint8Array | string>;
  egress?: string[];
}

/** @deprecated archived v1 machine shape — Wave 5 deletes this. */
interface V1SandboxMachine {
  id: string;
  request(req: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
  }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
  exec(
    cmd: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  files: {
    read(path: string): Promise<Uint8Array>;
    write(path: string, bytes: Uint8Array | string): Promise<void>;
    list(dir: string): Promise<string[]>;
  };
  snapshot(): Promise<string>;
  screenshot?(): Promise<Uint8Array>;
  url?(port: number): Promise<string>;
  stop(): Promise<void>;
}

/** @deprecated archived v1 adapter seam — Wave 5 deletes this. */
export interface V1CloudSandboxAdapter {
  create(spec: V1SandboxCreateSpec): Promise<V1SandboxMachine>;
  resume(snapshotRef: string): Promise<V1SandboxMachine>;
}
// ─── end Wave-5 port pending ────────────────────────────────────────────────

/** The console mounts the managed-sandbox surface here
 * (apps/console/app/api/v1/sandboxes/*). */
const CONSOLE_SANDBOX_PATH = "/api/v1/sandboxes";

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

/** The console's "unavailable"/"quota-exhausted" have no VendoError twin;
 * unknown codes fall to sandbox-unavailable (the 402/401 → cloud-required
 * mapping lives in the shared raiseCloudError). */
const raiseSandboxError = (response: Response): Promise<never> =>
  raiseCloudError(response, "sandbox", (_code, message) => {
    throw new VendoError("sandbox-unavailable", message);
  });

/** The Cloud sandbox adapter — the OSS side of the managed-sandbox seam: a
 * plain SandboxAdapter speaking HTTP to the console's /api/v1/sandboxes
 * routes (Vendo's pooled provider capacity, metered as sandbox_minutes).
 * Cloned from cloudConnections' shape: behavior comes ONLY from constructor
 * arguments (adapter rule — see selectSandbox in server.ts); the adapter
 * never reads the environment. */
export function cloudSandbox(options: CloudSandboxOptions): V1CloudSandboxAdapter {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const send = consoleSender({
    base,
    mountPath: CONSOLE_SANDBOX_PATH,
    apiKey: options.apiKey,
    timeoutMs,
    fetchImpl,
    raise: raiseSandboxError,
  });

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
