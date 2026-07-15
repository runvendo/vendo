import { VendoError } from "@vendoai/core";
import type { SandboxAdapter, SandboxMachine } from "../sandbox.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_PORT = 8080;
const SNAPSHOT_REF_PREFIX = "e2b:v1:";

export interface E2BSandboxOptions {
  /** E2B API key. When omitted, the SDK reads E2B_API_KEY. */
  apiKey?: string;
  /** Provider machine lifetime and reconnect timeout, in milliseconds. */
  timeoutMs?: number;
}

type E2BMachine = InstanceType<typeof import("e2b").Sandbox>;

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => value.slice().buffer as ArrayBuffer;

const responseHeaders = (headers: Headers): Record<string, string> =>
  Object.fromEntries(headers.entries());

interface E2BSnapshotState {
  version: 1;
  snapshotId: string;
  egress?: string[];
  port: number;
}

const parsePort = (env: Record<string, string>): number => {
  const port = Number(env.PORT ?? DEFAULT_PORT);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_PORT;
};

const encodeSnapshotRef = (snapshotId: string, egress: string[] | undefined, port: number): string =>
  `${SNAPSHOT_REF_PREFIX}${Buffer.from(JSON.stringify({
    version: 1,
    snapshotId,
    ...(egress === undefined ? {} : { egress: [...egress] }),
    port,
  } satisfies E2BSnapshotState)).toString("base64url")}`;

const decodeSnapshotRef = (snapshotRef: string): E2BSnapshotState => {
  if (!snapshotRef.startsWith(SNAPSHOT_REF_PREFIX) || snapshotRef.length === SNAPSHOT_REF_PREFIX.length) {
    throw new VendoError("validation", "E2B snapshot references must start with e2b:v1:");
  }
  try {
    const value = JSON.parse(Buffer.from(snapshotRef.slice(SNAPSHOT_REF_PREFIX.length), "base64url").toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null) throw new Error("not an object");
    const state = value as Record<string, unknown>;
    if (state.version !== 1 || typeof state.snapshotId !== "string" || state.snapshotId.length === 0) {
      throw new Error("invalid snapshot id");
    }
    if (!Number.isInteger(state.port) || (state.port as number) <= 0 || (state.port as number) > 65_535) {
      throw new Error("invalid port");
    }
    if (state.egress !== undefined && (!Array.isArray(state.egress) || state.egress.some((host) => typeof host !== "string"))) {
      throw new Error("invalid egress policy");
    }
    return {
      version: 1,
      snapshotId: state.snapshotId,
      ...(state.egress === undefined ? {} : { egress: [...state.egress as string[]] }),
      port: state.port as number,
    };
  } catch {
    throw new VendoError("validation", "invalid E2B snapshot reference");
  }
};

const networkOptions = (egress: string[] | undefined, allTraffic: string) => egress === undefined
  ? { allowInternetAccess: true as const }
  : { network: { allowOut: [...egress], denyOut: [allTraffic] } };

/**
 * 06-apps §3–4 — adapt an E2B sandbox to Vendo's provider-neutral seam.
 *
 * E2B point-in-time snapshots create reusable checkpoints while leaving the
 * source machine running. Every resume creates a distinct sandbox from that
 * checkpoint. Per-app egress is supplied additively
 * on `create(spec).egress`: undefined is unrestricted, while a present list is
 * enforced with E2B's provider-native allowlist plus an all-traffic deny rule.
 * The optional SDK is imported only when create/resume is called.
 */
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

export const e2bSandbox = (options: E2BSandboxOptions = {}): SandboxAdapter => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const wrap = (
    sandbox: E2BMachine,
    state: Pick<E2BSnapshotState, "egress" | "port">,
  ): SandboxMachine => {
    const baseUrl = (port: number): string => `https://${sandbox.getHost(port)}`;

    return {
      id: sandbox.sandboxId,
      async request(request) {
        const response = await fetch(`${baseUrl(state.port)}${request.path.startsWith("/") ? request.path : `/${request.path}`}`, {
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
      async exec(cmd, execOptions) {
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
        async read(path) {
          return sandbox.files.read(path, { format: "bytes" });
        },
        async write(path, bytes) {
          await sandbox.files.write(path, typeof bytes === "string" ? bytes : toArrayBuffer(bytes));
        },
        async list(dir) {
          return (await sandbox.files.list(dir)).map((entry) => entry.name);
        },
      },
      async snapshot() {
        const snapshot = await sandbox.createSnapshot();
        return encodeSnapshotRef(snapshot.snapshotId, state.egress, state.port);
      },
      async url(port) {
        return baseUrl(port);
      },
      async stop() {
        await sandbox.kill();
      },
    };
  };

  return {
    async create(spec) {
      const { ALL_TRAFFIC, Sandbox } = await import("e2b");
      const sandbox = await Sandbox.create({
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        envs: spec.env,
        timeoutMs,
        ...networkOptions(spec.egress, ALL_TRAFFIC),
      });
      const initialFiles = Object.entries(spec.files ?? {}).map(([path, data]) => ({
        path,
        data: typeof data === "string" ? data : toArrayBuffer(data),
      }));
      if (initialFiles.length > 0) await sandbox.files.write(initialFiles);
      return wrap(sandbox, { egress: spec.egress, port: parsePort(spec.env) });
    },
    async resume(snapshotRef) {
      const state = decodeSnapshotRef(snapshotRef);
      const { ALL_TRAFFIC, Sandbox } = await import("e2b");
      return wrap(await Sandbox.create(state.snapshotId, {
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        timeoutMs,
        ...networkOptions(state.egress, ALL_TRAFFIC),
      }), state);
    },
  };
};
