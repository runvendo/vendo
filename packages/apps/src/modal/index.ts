import { VendoError } from "@vendoai/core";
import type { SandboxAdapter, SandboxMachine } from "../sandbox.js";

const DEFAULT_PORT = 8080;
const APP_NAME = "vendo-apps";
const BASE_IMAGE = "node:22-alpine";
const STATE_PATH = "/app/.vendo-modal-state.json";
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

interface SerializedMachineState extends MachineState {
  version: 1;
}

const textEncoder = new TextEncoder();

const toBytes = (value: Uint8Array | string): Uint8Array =>
  typeof value === "string" ? textEncoder.encode(value) : value.slice();

const serializeState = (state: MachineState): Uint8Array => textEncoder.encode(JSON.stringify({
  version: 1,
  env: { ...state.env },
  ...(state.egress === undefined ? {} : { egress: [...state.egress] }),
  port: state.port,
} satisfies SerializedMachineState));

const deserializeState = (bytes: Uint8Array): MachineState => {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (typeof value !== "object" || value === null) throw new Error("not an object");
    const state = value as Record<string, unknown>;
    if (state.version !== 1 || typeof state.env !== "object" || state.env === null || Array.isArray(state.env)) {
      throw new Error("invalid state envelope");
    }
    const env = state.env as Record<string, unknown>;
    if (Object.values(env).some((entry) => typeof entry !== "string")) throw new Error("invalid env");
    if (!Number.isInteger(state.port) || (state.port as number) <= 0 || (state.port as number) > 65_535) {
      throw new Error("invalid port");
    }
    if (state.egress !== undefined && (!Array.isArray(state.egress) || state.egress.some((host) => typeof host !== "string"))) {
      throw new Error("invalid egress policy");
    }
    return {
      env: { ...env } as Record<string, string>,
      ...(state.egress === undefined ? {} : { egress: [...state.egress as string[]] }),
      port: state.port as number,
    };
  } catch {
    throw new VendoError("sandbox-unavailable", "Modal snapshot is missing durable runtime state");
  }
};

const parsePort = (env: Record<string, string>): number => {
  const port = Number(env.PORT ?? DEFAULT_PORT);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_PORT;
};

const responseHeaders = (headers: Headers): Record<string, string> =>
  Object.fromEntries(headers.entries());

const networkOptions = (egress: string[] | undefined): {
  blockNetwork?: boolean;
  outboundCidrAllowlist?: string[];
  outboundDomainAllowlist?: string[];
} => egress === undefined
  ? {}
  : egress.length === 0
    ? { outboundCidrAllowlist: [], outboundDomainAllowlist: [] }
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
 * list uses empty outbound-only CIDR/domain allowlists so serving tunnels stay
 * reachable. Image restore reads a versioned state manifest
 * captured inside the image, so env, egress, and port survive adapter/process
 * restarts. State discovery runs in a short-lived network-blocked probe before
 * the restored machine is created with its original policy. The optional SDK
 * is imported lazily.
 */
export const modalSandbox = (options: ModalSandboxOptions = {}): SandboxAdapter => {
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
    return client.sandboxes.create(app, image, createParams(state));
  };

  const persistState = (sandbox: ModalMachine, state: MachineState): Promise<void> =>
    sandbox.filesystem.writeBytes(serializeState(state), STATE_PATH);

  const readState = async (sandbox: ModalMachine): Promise<MachineState> =>
    deserializeState(await sandbox.filesystem.readBytes(STATE_PATH));

  const probeImageState = async (client: ModalClient, image: ModalImage): Promise<MachineState> => {
    const app = await client.apps.fromName(APP_NAME, { createIfMissing: true });
    const probe = await client.sandboxes.create(app, image, {
      env: {},
      command: ["sh", "-c", "sleep 300"],
      workdir: "/app",
      blockNetwork: true,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    });
    try {
      return await readState(probe);
    } finally {
      await probe.terminate().catch(() => undefined);
    }
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
        await persistState(sandbox, state);
        const image = await sandbox.snapshotFilesystem();
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
      await persistState(sandbox, state);
      return wrap(sandbox, state);
    },
    async resume(snapshotRef) {
      const client = await newClient();
      if (snapshotRef.startsWith("modal:sb_") && snapshotRef.length > "modal:sb_".length) {
        const sandboxId = snapshotRef.slice("modal:sb_".length);
        const sandbox = await client.sandboxes.fromId(sandboxId);
        return wrap(sandbox, await readState(sandbox));
      }
      if (snapshotRef.startsWith("modal:im_") && snapshotRef.length > "modal:im_".length) {
        const imageId = snapshotRef.slice("modal:im_".length);
        const image = await client.images.fromId(imageId);
        const state = await probeImageState(client, image);
        return wrap(await spawn(client, image, state), state);
      }
      throw new VendoError("validation", "Modal snapshot references must start with modal:im_ or modal:sb_");
    },
  };
};
