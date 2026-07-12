import { VendoError } from "@vendoai/core";
import type { SandboxAdapter, SandboxMachine } from "../sandbox.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_PORT = 8080;

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

const refId = (snapshotRef: string): string => {
  if (!snapshotRef.startsWith("e2b:") || snapshotRef.length === "e2b:".length) {
    throw new VendoError("validation", "E2B snapshot references must start with e2b:");
  }
  return snapshotRef.slice("e2b:".length);
};

/**
 * 06-apps §3–4 — adapt an E2B sandbox to Vendo's provider-neutral seam.
 *
 * E2B snapshots pause and later resume the same machine, preserving memory,
 * disk, processes, and the sandbox id. Per-app egress is supplied additively
 * on `create(spec).egress`: undefined is unrestricted, while a present list is
 * enforced with E2B's provider-native allowlist plus an all-traffic deny rule.
 * The optional SDK is imported only when create/resume is called.
 */
export const e2bSandbox = (options: E2BSandboxOptions = {}): SandboxAdapter => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const wrap = (sandbox: E2BMachine): SandboxMachine => {
    const baseUrl = (port: number): string => `https://${sandbox.getHost(port)}`;

    return {
      id: sandbox.sandboxId,
      async request(request) {
        const response = await fetch(`${baseUrl(DEFAULT_PORT)}${request.path.startsWith("/") ? request.path : `/${request.path}`}`, {
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
        const result = await sandbox.commands.run(cmd, {
          ...(execOptions?.cwd === undefined ? {} : { cwd: execOptions.cwd }),
          timeoutMs: execOptions?.timeoutMs ?? timeoutMs,
        });
        return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
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
        await sandbox.pause();
        return `e2b:${sandbox.sandboxId}`;
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
        ...(spec.egress === undefined
          ? { allowInternetAccess: true }
          : { network: { allowOut: [...spec.egress], denyOut: [ALL_TRAFFIC] } }),
      });
      const initialFiles = Object.entries(spec.files ?? {}).map(([path, data]) => ({
        path,
        data: typeof data === "string" ? data : toArrayBuffer(data),
      }));
      if (initialFiles.length > 0) await sandbox.files.write(initialFiles);
      return wrap(sandbox);
    },
    async resume(snapshotRef) {
      const sandboxId = refId(snapshotRef);
      const { Sandbox } = await import("e2b");
      return wrap(await Sandbox.connect(sandboxId, {
        ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        timeoutMs,
      }));
    },
  };
};
