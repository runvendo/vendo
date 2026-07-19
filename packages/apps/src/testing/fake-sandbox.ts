import type { SandboxAdapter, SandboxMachine } from "../sandbox.js";

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

export interface FakeExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface FakeExecCall {
  cmd: string;
  opts?: { cwd?: string; timeoutMs?: number };
}

/** The v2 create spec plus the deprecated v1 compat extras the fake still
    models (kept local so the fake never depends on the temporary
    sandbox-v1-compat module; both extras die with the v1 paths). */
export interface FakeCreateSpec {
  template?: string;
  env: Record<string, string>;
  allowedDomains?: string[];
  /** @deprecated v1 initial-files seeding; the in-box agent replaced it. */
  files?: Record<string, Uint8Array | string>;
  /** @deprecated v1 name for allowedDomains. */
  egress?: string[];
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

/** The provider-native wildcard-aware allowlist rule the fake simulates. */
const domainAllowed = (allowedDomains: readonly string[] | undefined, host: string): boolean =>
  allowedDomains === undefined || allowedDomains.some((rule) =>
    rule === host || (rule.startsWith("*.") && host.endsWith(rule.slice(1))));

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

const onePixelPng = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2,
  0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3,
  3, 2, 0, 238, 254, 127, 217, 0, 0, 0, 0, 73, 69, 78, 68, 174,
  66, 96, 130,
]);

/** Test machine with deterministic I/O and inspectable state. */
export class FakeSandboxMachine implements SandboxMachine {
  readonly requests: MachineRequest[] = [];
  readonly commands: FakeExecCall[] = [];
  readonly execResults: FakeExecResult[] = [];
  readonly fileContents: Map<string, Uint8Array>;
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
    this.app = app;
  }

  /** @deprecated v1 alias for allowedDomains, kept for the dying v1 call sites. */
  get egress(): readonly string[] | undefined {
    return this.allowedDomains;
  }

  private appContext(): MachineAppContext {
    return { env: this.env, allowedDomains: this.allowedDomains, port: this.port };
  }

  private ensureRunning(operation: string): void {
    if (this.destroyed) throw new Error(`Fake sandbox machine ${this.id} is destroyed; cannot ${operation}`);
    if (this.stopped) throw new Error(`Fake sandbox machine ${this.id} is stopped (asleep); cannot ${operation}`);
  }

  readonly files = {
    // Reads stay available after stop/destroy on purpose: the fake doubles as
    // a post-mortem probe for tests asserting what a torn-down machine held.
    // Every OPERATION (write/list/exec/screenshot/url/request/snapshot) is
    // lifecycle-guarded like a real provider.
    read: async (path: string): Promise<Uint8Array> => {
      const bytes = this.fileContents.get(path);
      if (bytes === undefined) throw new Error(`Unknown fake sandbox file: ${path}`);
      return bytes.slice();
    },
    write: async (path: string, bytes: Uint8Array | string): Promise<void> => {
      this.ensureRunning("write a file");
      this.fileContents.set(path, toBytes(bytes));
    },
    list: async (dir: string): Promise<string[]> => {
      this.ensureRunning("list files");
      const prefix = dir === "" || dir === "/" ? "" : `${dir.replace(/\/$/, "")}/`;
      return [...new Set(
        [...this.fileContents.keys()]
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length).split("/")[0])
          .filter((name): name is string => name !== undefined && name !== ""),
      )].sort();
    },
  };

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

  async exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<FakeExecResult> {
    this.ensureRunning("exec a command");
    this.commands.push(opts === undefined ? { cmd } : { cmd, opts: { ...opts } });
    const programmed = this.execResults.shift();
    if (programmed !== undefined) return programmed;

    const printedEnv = /^printf\s+'%s'\s+"\$([A-Za-z_][A-Za-z0-9_]*)"$/.exec(cmd)?.[1];
    if (printedEnv !== undefined) {
      return { code: 0, stdout: this.env[printedEnv] ?? "", stderr: "" };
    }

    const fetchedHost = /fetch\(['"]https:\/\/([^/'"]+)/.exec(cmd)?.[1];
    if (fetchedHost !== undefined) {
      const allowed = domainAllowed(this.allowedDomains, fetchedHost);
      const exits = /then\(\(\) => process\.exit\((\d+)\)\)\.catch\(\(\) => process\.exit\((\d+)\)\)/.exec(cmd);
      return {
        code: Number(allowed ? exits?.[1] ?? 0 : exits?.[2] ?? 1),
        stdout: "",
        stderr: "",
      };
    }

    return { code: 0, stdout: "", stderr: "" };
  }

  programExec(...results: FakeExecResult[]): void {
    this.execResults.push(...results.map((result) => ({ ...result })));
  }

  setApp(app: MachineApp): void {
    this.app = app;
  }

  async snapshot(): Promise<string> {
    this.ensureRunning("snapshot");
    return this.saveSnapshot(this);
  }

  async screenshot(): Promise<Uint8Array> {
    this.ensureRunning("capture a screenshot");
    return onePixelPng.slice();
  }

  async url(port: number): Promise<string> {
    this.ensureRunning("resolve a serving URL");
    return `http://fake-machine-${this.id}.local:${port}`;
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
  resume(snapshotRef: string): Promise<FakeSandboxMachine>;
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
      for (const [path, bytes] of Object.entries(spec.files ?? {})) files.set(path, toBytes(bytes));
      return makeMachine(
        spec.env,
        spec.allowedDomains ?? spec.egress,
        spec.template,
        files,
        installedApp ?? seed?.app,
      );
    },
    async resume(snapshotRef: string): Promise<FakeSandboxMachine> {
      const snapshot = providerSnapshots.get(snapshotRef);
      if (snapshot === undefined) throw new Error(`Unknown fake sandbox snapshot: ${snapshotRef}`);
      return makeMachine(
        { ...snapshot.env },
        snapshot.allowedDomains,
        snapshot.template,
        snapshot.files,
        snapshot.app,
      );
    },
  };
};
