import { safeErrorMessage, VendoError } from "@vendoai/core";
import type { SandboxAdapter, SandboxMachine } from "../sandbox.js";

const DEFAULT_TIMEOUT_MS = 300_000;
/** Throttle for sliding the provider deadline on request activity. */
const TTL_EXTEND_INTERVAL_MS = 60_000;
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

/** The v2 create spec (the seam's SandboxAdapter.create parameter, kept local
    for the adapter's internal signatures). */
type E2BCreateSpec = {
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
  /** The sandbox the snapshot was taken from, so adapter.destroy(ref) can
      also reap it when it was left paused by the sleep flow. */
  sourceSandboxId?: string;
  allowedDomains?: string[];
  port: number;
}

const parsePort = (env: Record<string, string>): number => {
  const port = Number(env.PORT ?? DEFAULT_PORT);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_PORT;
};

const encodeSnapshotRef = (
  snapshotId: string,
  sourceSandboxId: string,
  allowedDomains: string[] | undefined,
  port: number,
): string =>
  `${SNAPSHOT_REF_PREFIX}${Buffer.from(JSON.stringify({
    version: 2,
    snapshotId,
    sourceSandboxId,
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
      if (state.sourceSandboxId !== undefined
        && (typeof state.sourceSandboxId !== "string" || state.sourceSandboxId.length === 0)) {
        throw new Error("invalid source sandbox id");
      }
      return {
        snapshotId: state.snapshotId,
        ...(state.sourceSandboxId === undefined ? {} : { sourceSandboxId: state.sourceSandboxId }),
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

/** True when the optional `e2b` SDK is actually loadable from this runtime,
    so callers can avoid wiring an adapter whose first create() would die on a
    missing module. Because loadE2b routes through a mutable specifier, NO
    bundler ever inlines the SDK — the runtime's own module resolution is the
    only truth — so the probe must test USABILITY, not importability: ask
    Node's require.resolve first (authoritative even inside a server bundle,
    where the emulated `import.meta` carries no `resolve` — Turbopack's shim
    made the old "no resolve ⇒ bundler inlined it ⇒ available" fallback claim
    e2b on hosts without the SDK, flipping the venue ladder away from the
    Cloud sandbox: 0.4.4 defect C), then real `import.meta.resolve` (pure-ESM
    Node without process.getBuiltinModule), and read an unverifiable runtime
    as NOT installed — a dynamic import of the bare specifier would fail there
    anyway. The specifier parameter exists for tests. */
export const e2bInstalled = (specifier: string = E2B_SPECIFIER): boolean => {
  const nodeResolves = nodeResolveProbe(specifier);
  if (nodeResolves !== undefined) return nodeResolves;
  if (typeof import.meta.resolve === "function") {
    try {
      import.meta.resolve(specifier);
      return true;
    } catch {
      return false;
    }
  }
  return false;
};

/** require.resolve probe via process.getBuiltinModule (Node ≥20.16) — no
    static node:module import, so Worker/edge bundles of this module stay
    clean. Returns undefined when this runtime has no Node resolver to ask. */
const nodeResolveProbe = (specifier: string): boolean | undefined => {
  const proc = (globalThis as {
    process?: { getBuiltinModule?: (id: string) => unknown; cwd?: () => string };
  }).process;
  if (typeof proc?.getBuiltinModule !== "function") return undefined;
  let createRequire: ((from: string) => { resolve: (id: string) => string }) | undefined;
  try {
    createRequire = (proc.getBuiltinModule("node:module") as { createRequire?: typeof createRequire } | undefined)?.createRequire;
  } catch {
    return undefined;
  }
  if (typeof createRequire !== "function") return undefined;
  // Resolve from where the runtime import itself resolves: this module's URL
  // (bundlers rewrite import.meta.url to the original or bundled file path —
  // both walk up to the host's node_modules), falling back to the process cwd.
  const base = typeof import.meta.url === "string" && import.meta.url.startsWith("file:")
    ? import.meta.url
    : `${proc.cwd?.() ?? ""}/__vendo-e2b-probe__.js`;
  try {
    createRequire(base).resolve(specifier);
    return true;
  } catch {
    return false;
  }
};

/** Routed through a mutable binding so NO bundler statically resolves the
    optional SDK: the webpack/turbopack ignore comments below are webpack
    dialect, and esbuild (Wrangler, Bun) ignores them and hard-fails the build
    on a literal `import("e2b")` when the SDK isn't installed (field case:
    vendo-on-Cloudflare-Workers). A `let` defeats esbuild constant folding. */
let E2B_SPECIFIER = "e2b";

type E2BModule = typeof import("e2b");

const loadE2b = async (): Promise<E2BModule> => {
  try {
    return await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ E2B_SPECIFIER) as E2BModule;
  } catch (error) {
    throw new VendoError(
      "sandbox-unavailable",
      "the optional `e2b` SDK is not installed in this deployment; install `e2b` (and set E2B_API_KEY) to use the E2B sandbox adapter, or leave the sandbox seam to Vendo Cloud / a custom adapter",
      { loadError: safeErrorMessage(error) },
    );
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
 * The machine object also carries adapter-private exec/files used for
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
    // Seam rule: sleeping or destroying twice is not an error, and destroy is
    // final. The one-shot promises make that hold under concurrency too —
    // each transition is assigned synchronously, so racing callers share one
    // provider call instead of issuing duplicate pause()/kill()s, and a
    // destroy during an in-flight pause serializes after it.
    let sleeping: Promise<void> | undefined;
    let destroying: Promise<void> | undefined;
    // E2B's timeoutMs is a HARD deadline fixed at create/resume — proxied
    // traffic does not extend it, so a busy box would be provider-killed
    // mid-session (before the idle lifecycle ever snapshots it). Slide the
    // deadline on activity instead: best-effort and throttled, so the idle
    // auto-sleep — not the provider TTL — decides when the machine stops.
    let ttlExtendedAt = 0;
    const extendTtl = (): void => {
      const now = Date.now();
      if (now - ttlExtendedAt < TTL_EXTEND_INTERVAL_MS) return;
      ttlExtendedAt = now;
      void Promise.resolve(sandbox.setTimeout(timeoutMs)).catch(() => undefined);
    };

    return {
      id: sandbox.sandboxId,
      async request(request) {
        extendTtl();
        const response = await fetch(`${baseUrl(request.port ?? state.port)}${request.path.startsWith("/") ? request.path : `/${request.path}`}`, {
          method: request.method,
          headers: request.headers,
          body: request.body === undefined
            ? undefined
            : typeof request.body === "string"
              ? request.body
              : toArrayBuffer(request.body),
        });
        // The e2b ingress answers 502 for BOTH "app port not open yet" (boot
        // race, retried above the seam) and "sandbox reaped" (TTL, sweep).
        // Only the SDK knows which: a dead sandbox becomes the seam's thrown
        // not-found (the lifecycle evicts the live entry and re-wakes from
        // the durable ref); an inconclusive probe fails open to the plain 502.
        if (response.status === 502) {
          const running = await sandbox.isRunning().catch(() => true);
          if (!running) {
            throw new VendoError("not-found", `e2b sandbox ${sandbox.sandboxId} is gone (reaped by the provider)`);
          }
        }
        return {
          status: response.status,
          headers: responseHeaders(response.headers),
          body: new Uint8Array(await response.arrayBuffer()),
        };
      },
      async url(port?: number) {
        return baseUrl(port ?? state.port);
      },
      async snapshot() {
        const snapshot = await sandbox.createSnapshot();
        return encodeSnapshotRef(snapshot.snapshotId, sandbox.sandboxId, state.allowedDomains, state.port);
      },
      async stop() {
        if (destroying !== undefined) {
          await destroying;
          return;
        }
        sleeping ??= sandbox.pause().then(() => undefined);
        await sleeping;
      },
      async destroy() {
        destroying ??= (sleeping ?? Promise.resolve())
          .catch(() => undefined)
          .then(() => sandbox.kill())
          .then(() => undefined);
        await destroying;
      },
      // ——— adapter-private below this line (bootstrap/diagnostics + v1 compat) ———
      async exec(cmd: string, execOptions?: { cwd?: string; timeoutMs?: number }) {
        // Box bootstrap and diagnostics are activity too — a minutes-long
        // command sequence must slide the provider deadline like requests do.
        extendTtl();
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
    } satisfies SandboxMachine & Record<string, unknown> as SandboxMachine;
  };

  return {
    async create(spec: E2BCreateSpec) {
      // Optional SDK: keep it a runtime import so hosts without e2b installed
      // don't fail Next's (webpack/Turbopack) bundling of the vendo route.
      const { ALL_TRAFFIC, Sandbox } = await loadE2b();
      const allowedDomains = spec.allowedDomains;
      const createOptions = {
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        envs: spec.env,
        timeoutMs,
        ...networkOptions(allowedDomains, ALL_TRAFFIC),
      };
      const sandbox = spec.template === undefined
        ? await Sandbox.create(createOptions)
        : await Sandbox.create(spec.template, createOptions);
      return wrap(sandbox, { allowedDomains, port: parsePort(spec.env) });
    },
    async resume(snapshotRef, policy) {
      const state = decodeSnapshotRef(snapshotRef);
      // Lane E — a wake enforces the CURRENT egress policy when the caller
      // passes one; the snapshot-time allowlist applies only to a bare resume.
      const allowedDomains = policy === undefined ? state.allowedDomains : policy.allowedDomains;
      const { ALL_TRAFFIC, Sandbox } = await loadE2b();
      return wrap(await Sandbox.create(state.snapshotId, {
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        timeoutMs,
        ...networkOptions(allowedDomains, ALL_TRAFFIC),
      }), { ...state, allowedDomains });
    },
    async destroy(snapshotRef) {
      const state = decodeSnapshotRef(snapshotRef);
      const { NotFoundError, Sandbox } = await loadE2b();
      const apiOptions = options.apiKey === undefined ? {} : { apiKey: options.apiKey };
      // Best-effort reap of the sandbox the sleep flow left paused behind this
      // ref (recorded by v2 refs; absent from retired v1 refs). It is usually
      // already gone — the machine's own destroy() killed it — so any failure
      // here is not this call's problem.
      if (state.sourceSandboxId !== undefined) {
        await Sandbox.kill(state.sourceSandboxId, apiOptions).catch(() => undefined);
      }
      try {
        await Sandbox.deleteSnapshot(state.snapshotId, apiOptions);
      } catch (error) {
        // Idempotent by seam contract: already-deleted state is a no-op. The
        // name fallback covers an SDK bump or bundler duplicating the class.
        const notFound = error instanceof NotFoundError
          || (error instanceof Error && error.name === "NotFoundError");
        if (!notFound) throw error;
      }
    },
  };
};
