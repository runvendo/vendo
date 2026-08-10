import type { SandboxAdapter, SandboxMachine } from "../escalation/sandbox.js";
import { inMemoryBoxFiles } from "./box-files.js";

export interface MachineRequest {
  method: string;
  path: string;
  port?: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

export interface MachineResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
}

/** The box's boundary as the fake's in-process app handler sees it. */
export interface MachineAppContext {
  env: Readonly<Record<string, string>>;
  allowedDomains: readonly string[] | undefined;
  port: number;
}

export type MachineApp = (
  request: MachineRequest,
  ctx: MachineAppContext,
) => MachineResponse | Promise<MachineResponse>;

/** The v2 create spec (the seam's SandboxAdapter.create parameter, kept local
    for the fake's internal signatures). */
export interface FakeCreateSpec {
  template?: string;
  env: Record<string, string>;
  allowedDomains?: string[];
}

interface FakeSnapshot {
  env: Readonly<Record<string, string>>;
  allowedDomains?: readonly string[];
  template?: string;
  files: ReadonlyMap<string, Uint8Array>;
  app: MachineApp | undefined;
}

// Fake provider state intentionally outlives one adapter object, matching the
// durable provider refs returned by the real adapters across process restarts.
const providerSnapshots = new Map<string, FakeSnapshot>();
let nextProviderMachine = 1;
let nextProviderSnapshot = 1;

const DEFAULT_PORT = 8080;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toBytes = (value: Uint8Array | string): Uint8Array =>
  typeof value === "string" ? textEncoder.encode(value) : value.slice();

const parsePort = (env: Record<string, string>): number => {
  const port = Number(env.PORT ?? DEFAULT_PORT);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_PORT;
};

const cloneRequest = (request: MachineRequest): MachineRequest => ({
  ...request,
  headers: request.headers === undefined ? undefined : { ...request.headers },
  body: request.body instanceof Uint8Array ? request.body.slice() : request.body,
});

const bodyArgs = (body: Uint8Array | string | undefined): unknown => {
  if (body === undefined) return undefined;
  try {
    const parsed = JSON.parse(typeof body === "string" ? body : textDecoder.decode(body)) as unknown;
    return typeof parsed === "object" && parsed !== null && "args" in parsed
      ? (parsed as { args?: unknown }).args
      : undefined;
  } catch {
    return undefined;
  }
};

const defaultApp: MachineApp = (request, ctx) => {
  const match = /^\/fn\/([A-Za-z_][A-Za-z0-9_-]*)$/.exec(request.path);
  if (request.method.toUpperCase() === "POST" && match?.[1] !== undefined) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          name: match[1],
          args: bodyArgs(request.body),
          env: { ...ctx.env },
          headers: { ...request.headers },
        },
      }),
    };
  }
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: "<!doctype html><title>Fake Vendo app</title>",
  };
};

/** Test machine with deterministic I/O and inspectable state. */
export class FakeSandboxMachine implements SandboxMachine {
  readonly requests: MachineRequest[] = [];
  readonly fileContents: Map<string, Uint8Array>;
  /** The seam's file operations (sandbox.ts), over this machine's contents.
   *  Url/request/snapshot are lifecycle-guarded separately. */
  readonly files: SandboxMachine["files"];
  readonly env: Record<string, string>;
  readonly port: number;
  /** v2 sleep flag; also true once destroyed. Writable for test scripting. */
  stopped = false;
  /** v2 gone-for-good flag. */
  destroyed = false;
  app: MachineApp | undefined;

  constructor(
    readonly id: string,
    env: Record<string, string>,
    readonly allowedDomains: readonly string[] | undefined,
    readonly template: string | undefined,
    files: ReadonlyMap<string, Uint8Array>,
    app: MachineApp | undefined,
    private readonly saveSnapshot: (machine: FakeSandboxMachine) => string,
  ) {
    this.env = Object.freeze({ ...env });
    this.port = parsePort(this.env);
    this.fileContents = new Map([...files].map(([path, bytes]) => [path, bytes.slice()]));
    this.files = inMemoryBoxFiles(this.fileContents, (operation) => this.ensureRunning(operation));
    this.app = app;
  }

  private appContext(): MachineAppContext {
    return { env: this.env, allowedDomains: this.allowedDomains, port: this.port };
  }

  private ensureRunning(operation: string): void {
    if (this.destroyed) throw new Error(`Fake sandbox machine ${this.id} is destroyed; cannot ${operation}`);
    if (this.stopped) throw new Error(`Fake sandbox machine ${this.id} is stopped (asleep); cannot ${operation}`);
  }

  async request(request: MachineRequest): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
    this.ensureRunning("serve a request");
    const port = request.port ?? this.port;
    if (port !== this.port) {
      throw new Error(`Fake sandbox machine ${this.id} has no listener on port ${port} (the app's $PORT is ${this.port})`);
    }
    this.requests.push({ ...cloneRequest(request), port });
    const response = await (this.app ?? defaultApp)(cloneRequest(request), this.appContext());
    return {
      status: response.status,
      headers: { ...response.headers },
      body: toBytes(response.body),
    };
  }

  setApp(app: MachineApp): void {
    this.app = app;
  }

  async snapshot(): Promise<string> {
    this.ensureRunning("snapshot");
    return this.saveSnapshot(this);
  }

  async url(port?: number): Promise<string> {
    this.ensureRunning("resolve a serving URL");
    return `http://fake-machine-${this.id}.local:${port ?? this.port}`;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async destroy(): Promise<void> {
    this.stopped = true;
    this.destroyed = true;
  }
}

export interface FakeSandboxAdapter extends SandboxAdapter {
  readonly machines: Map<string, FakeSandboxMachine>;
  create(spec: FakeCreateSpec): Promise<FakeSandboxMachine>;
  resume(snapshotRef: string, policy?: { allowedDomains: string[] | undefined }): Promise<FakeSandboxMachine>;
  setApp(app: MachineApp): void;
}

/** Create an in-process sandbox adapter whose requests dispatch to a machine app handler. */
export const fakeSandbox = (options: { app?: MachineApp } = {}): FakeSandboxAdapter => {
  const machines = new Map<string, FakeSandboxMachine>();
  let installedApp = options.app;

  const saveSnapshot = (machine: FakeSandboxMachine): string => {
    const ref = `fake:snap_${nextProviderSnapshot++}`;
    providerSnapshots.set(ref, Object.freeze({
      env: Object.freeze({ ...machine.env }),
      ...(machine.allowedDomains === undefined ? {} : { allowedDomains: Object.freeze([...machine.allowedDomains]) }),
      ...(machine.template === undefined ? {} : { template: machine.template }),
      files: new Map([...machine.fileContents].map(([path, bytes]) => [path, bytes.slice()])),
      app: machine.app,
    }));
    return ref;
  };

  const makeMachine = (
    env: Record<string, string>,
    allowedDomains: readonly string[] | undefined,
    template: string | undefined,
    files: ReadonlyMap<string, Uint8Array>,
    app?: MachineApp,
  ): FakeSandboxMachine => {
    const id = String(nextProviderMachine++);
    const machine = new FakeSandboxMachine(
      id,
      env,
      allowedDomains === undefined ? undefined : Object.freeze([...allowedDomains]),
      template,
      files,
      app,
      saveSnapshot,
    );
    machines.set(id, machine);
    return machine;
  };

  return {
    machines,
    setApp(app: MachineApp): void {
      installedApp = app;
      for (const machine of machines.values()) machine.setApp(app);
    },
    async create(spec: FakeCreateSpec): Promise<FakeSandboxMachine> {
      const files = new Map<string, Uint8Array>();
      // A template ref that names a stored snapshot seeds the machine from it,
      // matching real providers where snapshots double as templates.
      const seed = spec.template === undefined ? undefined : providerSnapshots.get(spec.template);
      for (const [path, bytes] of seed?.files ?? []) files.set(path, bytes.slice());
      return makeMachine(
        spec.env,
        spec.allowedDomains,
        spec.template,
        files,
        installedApp ?? seed?.app,
      );
    },
    async resume(snapshotRef: string, policy?: { allowedDomains: string[] | undefined }): Promise<FakeSandboxMachine> {
      const snapshot = providerSnapshots.get(snapshotRef);
      if (snapshot === undefined) throw new Error(`Unknown fake sandbox snapshot: ${snapshotRef}`);
      return makeMachine(
        { ...snapshot.env },
        // Lane E — a passed policy replaces the snapshot-time allowlist (seam rule).
        policy === undefined ? snapshot.allowedDomains : policy.allowedDomains,
        snapshot.template,
        snapshot.files,
        snapshot.app,
      );
    },
    async destroy(snapshotRef: string): Promise<void> {
      if (!snapshotRef.startsWith("fake:")) {
        throw new Error(`not a fake sandbox snapshot ref: ${snapshotRef}`);
      }
      // Idempotent by seam contract: deleting absent state is a no-op.
      providerSnapshots.delete(snapshotRef);
    },
  };
};
