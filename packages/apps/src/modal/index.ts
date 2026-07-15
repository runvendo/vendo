import { VendoError } from "@vendoai/core";
import type { SandboxAdapter, SandboxMachine } from "../sandbox.js";

const DEFAULT_PORT = 8080;
const APP_NAME = "vendo-apps";
const BASE_IMAGE = "node:22-alpine";
const SNAPSHOT_REF_PREFIX = "modal:v1:";
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

interface ModalSnapshotState extends MachineState {
  version: 1;
  imageId: string;
}

const textEncoder = new TextEncoder();

const toBytes = (value: Uint8Array | string): Uint8Array =>
  typeof value === "string" ? textEncoder.encode(value) : value.slice();

const encodeSnapshotRef = (imageId: string, state: MachineState): string =>
  `${SNAPSHOT_REF_PREFIX}${Buffer.from(JSON.stringify({
    version: 1,
    imageId,
    env: { ...state.env },
    ...(state.egress === undefined ? {} : { egress: [...state.egress] }),
    port: state.port,
  } satisfies ModalSnapshotState)).toString("base64url")}`;

const decodeSnapshotRef = (snapshotRef: string): ModalSnapshotState => {
  if (!snapshotRef.startsWith(SNAPSHOT_REF_PREFIX) || snapshotRef.length === SNAPSHOT_REF_PREFIX.length) {
    throw new VendoError("validation", "Modal snapshot references must start with modal:v1:");
  }
  try {
    const value = JSON.parse(
      Buffer.from(snapshotRef.slice(SNAPSHOT_REF_PREFIX.length), "base64url").toString("utf8"),
    ) as unknown;
    if (typeof value !== "object" || value === null) throw new Error("not an object");
    const state = value as Record<string, unknown>;
    if (state.version !== 1 || typeof state.imageId !== "string" || state.imageId.length === 0 ||
      typeof state.env !== "object" || state.env === null || Array.isArray(state.env)) {
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
      version: 1,
      imageId: state.imageId,
      env: { ...env } as Record<string, string>,
      ...(state.egress === undefined ? {} : { egress: [...state.egress as string[]] }),
      port: state.port as number,
    };
  } catch {
    throw new VendoError("validation", "invalid Modal snapshot reference");
  }
};

const parsePort = (env: Record<string, string>): number => {
  const port = Number(env.PORT ?? DEFAULT_PORT);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_PORT;
};

const responseHeaders = (headers: Headers): Record<string, string> =>
  Object.fromEntries(headers.entries());

/**
 * ENG-322 — Modal's allowlists are ADDITIVE and independent: traffic passes when
 * it matches either list, and the SDK documents `outboundCidrAllowlist` as
 * "If not set, all CIDRs are allowed". A domain allowlist alone therefore
 * leaves raw-IP egress (e.g. `fetch("https://93.184.216.34/")`) wide open —
 * fail-open. Every present egress policy pins the CIDR allowlist to `[]` so
 * only the declared domains pass; `undefined` egress stays unrestricted.
 */
const networkOptions = (egress: string[] | undefined): {
  outboundCidrAllowlist?: string[];
  outboundDomainAllowlist?: string[];
} => egress === undefined
  ? {}
  : { outboundCidrAllowlist: [], outboundDomainAllowlist: [...egress] };

/**
 * 06-apps §3–4 — adapt a Modal sandbox to Vendo's provider-neutral seam.
 *
 * Modal `snapshot()` is disk-only, unlike E2B's memory resume: `modal:v1:...`
 * creates a new machine from the encoded image id and re-runs the start
 * command. Processes and the machine id do not survive. Modal snapshot images
 * expire after roughly 30 days by default.
 *
 * The app port must be declared in `encryptedPorts` at machine creation and
 * cannot be added later. Vendo therefore reads `$PORT` (default 8080) up front.
 * The start command waits for runtime-owned `/app/start.sh` or `/app/server.js`,
 * because Modal accepts initial files only through its post-create filesystem
 * API. Per-app egress uses Modal's provider-native domain allowlist with the
 * CIDR allowlist pinned to `[]` (fail-closed — see networkOptions); an empty
 * list therefore denies all egress while serving tunnels stay reachable
 * (tunnels are inbound). The adapter encodes the image id, env (including opaque secret
 * handles), egress, and port in a versioned opaque snapshot ref, so runtime
 * state survives adapter/process restarts without trusting app-writable files.
 * The optional SDK is imported lazily.
 */
/** True when the optional `modal` SDK resolves from this package, so callers
    can avoid wiring an adapter whose first create() would die on a missing
    module. Runtimes without `import.meta.resolve` (bundlers inline the
    dependency) are treated as available. */
export const modalInstalled = (): boolean => {
  if (typeof import.meta.resolve !== "function") return true;
  try {
    import.meta.resolve("modal");
    return true;
  } catch {
    return false;
  }
};

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
    // The optional SDK must stay a RUNTIME import: without the ignore hints,
    // Next (webpack and Turbopack) resolves the literal specifier while
    // bundling a host's route handler and fails the whole /api/vendo route
    // when the SDK isn't installed.
    const sdk = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "modal");
    return new sdk.ModalClient(clientOptions());
  };

  const spawn = async (client: ModalClient, image: ModalImage, state: MachineState): Promise<ModalMachine> => {
    const app = await client.apps.fromName(APP_NAME, { createIfMissing: true });
    return client.sandboxes.create(app, image, createParams(state));
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
        return encodeSnapshotRef(image.imageId, state);
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
      const state = decodeSnapshotRef(snapshotRef);
      const client = await newClient();
      const image = await client.images.fromId(state.imageId);
      return wrap(await spawn(client, image, state), state);
    },
  };
};
