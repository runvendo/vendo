import { VendoError } from "@vendoai/core";
import type { SandboxAdapter, SandboxMachine } from "../sandbox.js";

const DEFAULT_PORT = 8080;
const APP_NAME = "vendo-apps";
const BASE_IMAGE = "node:22-alpine";
const START_COMMAND = [
  "sh",
  "-c",
  "while [ ! -f /app/start.sh ] && [ ! -f /app/server.js ]; do sleep 0.05; done; cd /app; if [ -f start.sh ]; then exec sh start.sh; else exec node server.js; fi",
];

export interface ModalSandboxOptions {
  /** Modal token id. When omitted, the SDK reads MODAL_TOKEN_ID. */
  tokenId?: string;
  /** Modal token secret. When omitted, the SDK reads MODAL_TOKEN_SECRET. */
  tokenSecret?: string;
  /** Maximum machine lifetime in milliseconds. */
  timeoutMs?: number;
  /** Maximum idle lifetime in milliseconds. */
  idleTimeoutMs?: number;
}

type ModalModule = typeof import("modal");
type ModalMachine = InstanceType<ModalModule["Sandbox"]>;
type ModalClient = InstanceType<ModalModule["ModalClient"]>;
type ModalImage = InstanceType<ModalModule["Image"]>;

interface MachineState {
  env: Record<string, string>;
  egress?: string[];
  port: number;
}

const textEncoder = new TextEncoder();

const toBytes = (value: Uint8Array | string): Uint8Array =>
  typeof value === "string" ? textEncoder.encode(value) : value.slice();

const parsePort = (env: Record<string, string>): number => {
  const port = Number(env.PORT ?? DEFAULT_PORT);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_PORT;
};

const responseHeaders = (headers: Headers): Record<string, string> =>
  Object.fromEntries(headers.entries());

const networkOptions = (egress: string[] | undefined): {
  blockNetwork?: boolean;
  outboundDomainAllowlist?: string[];
} => egress === undefined
  ? {}
  : egress.length === 0
    ? { blockNetwork: true }
    : { outboundDomainAllowlist: [...egress] };

/**
 * 06-apps §3–4 — adapt a Modal sandbox to Vendo's provider-neutral seam.
 *
 * Modal `snapshot()` is disk-only, unlike E2B's memory resume: `modal:im_...`
 * creates a new machine from the image and re-runs the start command. Processes
 * and the machine id do not survive. Modal snapshot images expire after roughly
 * 30 days by default. `modal:sb_...` reconnects to a still-running sandbox.
 *
 * The app port must be declared in `encryptedPorts` at machine creation and
 * cannot be added later. Vendo therefore reads `$PORT` (default 8080) up front.
 * The start command waits for runtime-owned `/app/start.sh` or `/app/server.js`,
 * because Modal accepts initial files only through its post-create filesystem
 * API. Per-app egress uses Modal's provider-native domain allowlist; an empty
 * list sets `blockNetwork`. Image restore reuses the original create options
 * retained by this adapter instance. The optional SDK is imported lazily.
 */
export const modalSandbox = (options: ModalSandboxOptions = {}): SandboxAdapter => {
  const imageStates = new Map<string, MachineState>();
  const sandboxStates = new Map<string, MachineState>();

  const clientOptions = (): Pick<ModalSandboxOptions, "tokenId" | "tokenSecret"> => ({
    ...(options.tokenId === undefined ? {} : { tokenId: options.tokenId }),
    ...(options.tokenSecret === undefined ? {} : { tokenSecret: options.tokenSecret }),
  });

  const createParams = (state: MachineState) => ({
    env: { ...state.env },
    command: [...START_COMMAND],
    encryptedPorts: [state.port],
    workdir: "/app",
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...networkOptions(state.egress),
  });

  const newClient = async (): Promise<ModalClient> => {
    const sdk = await import("modal");
    return new sdk.ModalClient(clientOptions());
  };

  const spawn = async (client: ModalClient, image: ModalImage, state: MachineState): Promise<ModalMachine> => {
    const app = await client.apps.fromName(APP_NAME, { createIfMissing: true });
    const sandbox = await client.sandboxes.create(app, image, createParams(state));
    sandboxStates.set(sandbox.sandboxId, state);
    return sandbox;
  };

  const wrap = (sandbox: ModalMachine, state: MachineState): SandboxMachine => {
    const servingUrl = async (port: number): Promise<string> => {
      const tunnel = (await sandbox.tunnels(30_000))[port];
      if (tunnel === undefined) {
        throw new VendoError("sandbox-unavailable", `Modal sandbox has no encrypted tunnel for port ${port}`);
      }
      return tunnel.url;
    };

    return {
      id: sandbox.sandboxId,
      async request(request) {
        const base = await servingUrl(state.port);
        const response = await fetch(`${base}${request.path.startsWith("/") ? request.path : `/${request.path}`}`, {
          method: request.method,
          headers: request.headers,
          body: request.body === undefined
            ? undefined
            : typeof request.body === "string"
              ? request.body
              : request.body.slice().buffer as ArrayBuffer,
        });
        return {
          status: response.status,
          headers: responseHeaders(response.headers),
          body: new Uint8Array(await response.arrayBuffer()),
        };
      },
      async exec(cmd, execOptions) {
        const process = await sandbox.exec(["sh", "-c", cmd], {
          workdir: execOptions?.cwd ?? "/app",
          ...(execOptions?.timeoutMs === undefined ? {} : { timeoutMs: execOptions.timeoutMs }),
        });
        const [code, stdout, stderr] = await Promise.all([
          process.wait(),
          process.stdout.readText(),
          process.stderr.readText(),
        ]);
        return { code, stdout, stderr };
      },
      files: {
        async read(path) {
          return sandbox.filesystem.readBytes(path);
        },
        async write(path, bytes) {
          await sandbox.filesystem.writeBytes(toBytes(bytes), path);
        },
        async list(dir) {
          return (await sandbox.filesystem.listFiles(dir)).map((entry) => entry.name);
        },
      },
      async snapshot() {
        const image = await sandbox.snapshotFilesystem();
        imageStates.set(image.imageId, state);
        return `modal:im_${image.imageId}`;
      },
      url: servingUrl,
      async stop() {
        await sandbox.terminate();
      },
    };
  };

  return {
    async create(spec) {
      const client = await newClient();
      const state: MachineState = {
        env: { ...spec.env },
        ...(spec.egress === undefined ? {} : { egress: [...spec.egress] }),
        port: parsePort(spec.env),
      };
      const image = client.images.fromRegistry(BASE_IMAGE);
      const sandbox = await spawn(client, image, state);
      await Promise.all(Object.entries(spec.files ?? {}).map(([path, bytes]) =>
        sandbox.filesystem.writeBytes(toBytes(bytes), path)));
      return wrap(sandbox, state);
    },
    async resume(snapshotRef) {
      const client = await newClient();
      if (snapshotRef.startsWith("modal:sb_") && snapshotRef.length > "modal:sb_".length) {
        const sandboxId = snapshotRef.slice("modal:sb_".length);
        const state = sandboxStates.get(sandboxId) ?? { env: {}, port: DEFAULT_PORT };
        return wrap(await client.sandboxes.fromId(sandboxId), state);
      }
      if (snapshotRef.startsWith("modal:im_") && snapshotRef.length > "modal:im_".length) {
        const imageId = snapshotRef.slice("modal:im_".length);
        const state = imageStates.get(imageId) ?? { env: {}, port: DEFAULT_PORT };
        const image = await client.images.fromId(imageId);
        return wrap(await spawn(client, image, state), state);
      }
      throw new VendoError("validation", "Modal snapshot references must start with modal:im_ or modal:sb_");
    },
  };
};
