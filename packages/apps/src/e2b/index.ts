import { VendoError } from "@vendoai/core";
import type { SandboxAdapter, SandboxMachine } from "../sandbox.js";
import type { V1SandboxCreateSpec } from "../sandbox-v1-compat.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_PORT = 8080;
const SNAPSHOT_REF_PREFIX = "e2b:v2:";
/** Refs minted by the retired v1 adapter, still present in persisted app documents. */
const LEGACY_SNAPSHOT_REF_PREFIX = "e2b:v1:";

export interface E2BSandboxOptions {
  /** E2B API key. When omitted, the SDK reads E2B_API_KEY. */
  apiKey?: string;
  /** Provider machine lifetime and reconnect timeout, in milliseconds. */
  timeoutMs?: number;
}

type E2BMachine = InstanceType<typeof import("e2b").Sandbox>;

/** The v2 create spec plus the deprecated v1 compat extras this adapter still
    honors for the dying v1 call sites (see sandbox-v1-compat.ts header). */
type E2BCreateSpec = Pick<V1SandboxCreateSpec, "files" | "egress"> & {
  template?: string;
  env: Record<string, string>;
  allowedDomains?: string[];
};

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => value.slice().buffer as ArrayBuffer;

const responseHeaders = (headers: Headers): Record<string, string> =>
  Object.fromEntries(headers.entries());

interface E2BSnapshotState {
  version: 2;
  snapshotId: string;
  allowedDomains?: string[];
  port: number;
}

const parsePort = (env: Record<string, string>): number => {
  const port = Number(env.PORT ?? DEFAULT_PORT);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_PORT;
};

const encodeSnapshotRef = (
  snapshotId: string,
  allowedDomains: string[] | undefined,
  port: number,
): string =>
  `${SNAPSHOT_REF_PREFIX}${Buffer.from(JSON.stringify({
    version: 2,
    snapshotId,
    ...(allowedDomains === undefined ? {} : { allowedDomains: [...allowedDomains] }),
    port,
  } satisfies E2BSnapshotState)).toString("base64url")}`;

const validPort = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) <= 65_535;

const validDomains = (value: unknown): value is string[] | undefined =>
  value === undefined || (Array.isArray(value) && value.every((host) => typeof host === "string"));

const decodePayload = (payload: string): Record<string, unknown> => {
  const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null) throw new Error("not an object");
  return value as Record<string, unknown>;
};

const decodeSnapshotRef = (snapshotRef: string): Omit<E2BSnapshotState, "version"> => {
  try {
    if (snapshotRef.startsWith(SNAPSHOT_REF_PREFIX) && snapshotRef.length > SNAPSHOT_REF_PREFIX.length) {
      const state = decodePayload(snapshotRef.slice(SNAPSHOT_REF_PREFIX.length));
      if (state.version !== 2 || typeof state.snapshotId !== "string" || state.snapshotId.length === 0) {
        throw new Error("invalid snapshot id");
      }
      if (!validPort(state.port)) throw new Error("invalid port");
      if (!validDomains(state.allowedDomains)) throw new Error("invalid allowedDomains policy");
      return {
        snapshotId: state.snapshotId,
        ...(state.allowedDomains === undefined ? {} : { allowedDomains: [...state.allowedDomains] }),
        port: state.port,
      };
    }
    if (snapshotRef.startsWith(LEGACY_SNAPSHOT_REF_PREFIX) && snapshotRef.length > LEGACY_SNAPSHOT_REF_PREFIX.length) {
      const state = decodePayload(snapshotRef.slice(LEGACY_SNAPSHOT_REF_PREFIX.length));
      if (state.version !== 1 || typeof state.snapshotId !== "string" || state.snapshotId.length === 0) {
        throw new Error("invalid snapshot id");
      }
      if (!validPort(state.port)) throw new Error("invalid port");
      if (!validDomains(state.egress)) throw new Error("invalid egress policy");
      return {
        snapshotId: state.snapshotId,
        ...(state.egress === undefined ? {} : { allowedDomains: [...state.egress] }),
        port: state.port,
      };
    }
    throw new Error("unknown prefix");
  } catch {
    throw new VendoError("validation", "E2B snapshot references must start with e2b:v2: (or the retired e2b:v1:) and carry a valid payload");
  }
};

const networkOptions = (allowedDomains: string[] | undefined, allTraffic: string) =>
  allowedDomains === undefined
    ? { allowInternetAccess: true as const }
    : { network: { allowOut: [...allowedDomains], denyOut: [allTraffic] } };

/** True when the optional `e2b` SDK resolves from this package, so callers can
    avoid wiring an adapter whose first create() would die on a missing module.
    Runtimes without `import.meta.resolve` (bundlers inline the dependency) are
    treated as available. */
export const e2bInstalled = (): boolean => {
  if (typeof import.meta.resolve !== "function") return true;
  try {
    import.meta.resolve("e2b");
    return true;
  } catch {
    return false;
  }
};

/**
 * execution-v2 — adapt an E2B sandbox to Vendo's provider-neutral seam.
 *
 * Seam mapping: create() boots from an optional E2B template (point-in-time
 * snapshot ids double as templates); request() proxies HTTPS to the box's
 * $PORT host (or an explicit port); snapshot() takes a reusable point-in-time
 * checkpoint while the source keeps running; stop() is E2B's snapshot-
 * preserving pause; destroy() kills the machine (paused or running) for good.
 * allowedDomains rides E2B's provider-native network allowlist plus an
 * all-traffic deny rule; undefined means unrestricted egress.
 *
 * The machine object also carries adapter-private exec/files/url used for
 * bootstrap, diagnostics, and the dying v1 compat paths — they are NOT part
 * of the public seam (the in-box agent owns the inside of the box).
 * The optional SDK is imported only when create/resume is called.
 */
export const e2bSandbox = (options: E2BSandboxOptions = {}): SandboxAdapter => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const wrap = (
    sandbox: E2BMachine,
    state: { allowedDomains?: string[] | undefined; port: number },
  ): SandboxMachine => {
    const baseUrl = (port: number): string => `https://${sandbox.getHost(port)}`;
    // Seam rule: sleeping or destroying twice is not an error. Guarded here so
    // idempotence never depends on how a given e2b SDK version treats a second
    // pause()/kill() (a paused machine is never unpaused in place — resume()
    // always boots a new sandbox — so the flags can only move forward).
    let paused = false;
    let killed = false;

    return {
      id: sandbox.sandboxId,
      async request(request) {
        const response = await fetch(`${baseUrl(request.port ?? state.port)}${request.path.startsWith("/") ? request.path : `/${request.path}`}`, {
          method: request.method,
          headers: request.headers,
          body: request.body === undefined
            ? undefined
            : typeof request.body === "string"
              ? request.body
              : toArrayBuffer(request.body),
        });
        return {
          status: response.status,
          headers: responseHeaders(response.headers),
          body: new Uint8Array(await response.arrayBuffer()),
        };
      },
      async snapshot() {
        const snapshot = await sandbox.createSnapshot();
        return encodeSnapshotRef(snapshot.snapshotId, state.allowedDomains, state.port);
      },
      async stop() {
        if (paused || killed) return;
        await sandbox.pause();
        paused = true;
      },
      async destroy() {
        if (killed) return;
        await sandbox.kill();
        killed = true;
      },
      // ——— adapter-private below this line (bootstrap/diagnostics + v1 compat) ———
      async exec(cmd: string, execOptions?: { cwd?: string; timeoutMs?: number }) {
        try {
          const result = await sandbox.commands.run(cmd, {
            ...(execOptions?.cwd === undefined ? {} : { cwd: execOptions.cwd }),
            timeoutMs: execOptions?.timeoutMs ?? timeoutMs,
          });
          return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          if (typeof error === "object" && error !== null &&
            typeof (error as { exitCode?: unknown }).exitCode === "number" &&
            typeof (error as { stdout?: unknown }).stdout === "string" &&
            typeof (error as { stderr?: unknown }).stderr === "string") {
            const result = error as { exitCode: number; stdout: string; stderr: string };
            return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
          }
          throw error;
        }
      },
      files: {
        async read(path: string) {
          return sandbox.files.read(path, { format: "bytes" });
        },
        async write(path: string, bytes: Uint8Array | string) {
          await sandbox.files.write(path, typeof bytes === "string" ? bytes : toArrayBuffer(bytes));
        },
        async list(dir: string) {
          return (await sandbox.files.list(dir)).map((entry) => entry.name);
        },
      },
      async url(port: number) {
        return baseUrl(port);
      },
    } satisfies SandboxMachine & Record<string, unknown> as SandboxMachine;
  };

  return {
    async create(spec: E2BCreateSpec) {
      // Optional SDK: keep it a runtime import so hosts without e2b installed
      // don't fail Next's (webpack/Turbopack) bundling of the vendo route.
      const { ALL_TRAFFIC, Sandbox } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "e2b");
      const allowedDomains = spec.allowedDomains ?? spec.egress;
      const createOptions = {
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        envs: spec.env,
        timeoutMs,
        ...networkOptions(allowedDomains, ALL_TRAFFIC),
      };
      const sandbox = spec.template === undefined
        ? await Sandbox.create(createOptions)
        : await Sandbox.create(spec.template, createOptions);
      // v1 compat: initial-files seeding for the dying v1 call sites.
      const initialFiles = Object.entries(spec.files ?? {}).map(([path, data]) => ({
        path,
        data: typeof data === "string" ? data : toArrayBuffer(data),
      }));
      if (initialFiles.length > 0) await sandbox.files.write(initialFiles);
      return wrap(sandbox, { allowedDomains, port: parsePort(spec.env) });
    },
    async resume(snapshotRef) {
      const state = decodeSnapshotRef(snapshotRef);
      const { ALL_TRAFFIC, Sandbox } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "e2b");
      return wrap(await Sandbox.create(state.snapshotId, {
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        timeoutMs,
        ...networkOptions(state.allowedDomains, ALL_TRAFFIC),
      }), state);
    },
  };
};
