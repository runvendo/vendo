import type { SandboxAdapter, SandboxMachine } from "../sandbox.js";

export interface MachineRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

export interface MachineResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
}

export type MachineApp = (request: MachineRequest) => MachineResponse | Promise<MachineResponse>;

export interface FakeExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface FakeExecCall {
  cmd: string;
  opts?: { cwd?: string; timeoutMs?: number };
}

interface FakeSnapshot {
  env: Readonly<Record<string, string>>;
  egress?: readonly string[];
  files: ReadonlyMap<string, Uint8Array>;
  app: MachineApp;
}

// Fake provider state intentionally outlives one adapter object, matching the
// durable provider refs returned by the real adapters across process restarts.
const providerSnapshots = new Map<string, FakeSnapshot>();
let nextProviderMachine = 1;
let nextProviderSnapshot = 1;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toBytes = (value: Uint8Array | string): Uint8Array =>
  typeof value === "string" ? textEncoder.encode(value) : value.slice();

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

const defaultApp = (env: Record<string, string>): MachineApp => (request) => {
  const match = /^\/fn\/([A-Za-z_][A-Za-z0-9_-]*)$/.exec(request.path);
  if (request.method.toUpperCase() === "POST" && match?.[1] !== undefined) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        result: {
          name: match[1],
          args: bodyArgs(request.body),
          env: { ...env },
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
  stopped = false;
  app: MachineApp;

  constructor(
    readonly id: string,
    env: Record<string, string>,
    readonly egress: readonly string[] | undefined,
    files: ReadonlyMap<string, Uint8Array>,
    app: MachineApp | undefined,
    private readonly saveSnapshot: (machine: FakeSandboxMachine) => string,
  ) {
    this.env = Object.freeze({ ...env });
    this.fileContents = new Map([...files].map(([path, bytes]) => [path, bytes.slice()]));
    this.app = app ?? defaultApp(this.env);
  }

  readonly files = {
    read: async (path: string): Promise<Uint8Array> => {
      const bytes = this.fileContents.get(path);
      if (bytes === undefined) throw new Error(`Unknown fake sandbox file: ${path}`);
      return bytes.slice();
    },
    write: async (path: string, bytes: Uint8Array | string): Promise<void> => {
      this.fileContents.set(path, toBytes(bytes));
    },
    list: async (dir: string): Promise<string[]> => {
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
    if (this.stopped) throw new Error(`Fake sandbox machine ${this.id} is stopped`);
    this.requests.push(cloneRequest(request));
    const response = await this.app(cloneRequest(request));
    return {
      status: response.status,
      headers: { ...response.headers },
      body: toBytes(response.body),
    };
  }

  async exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<FakeExecResult> {
    this.commands.push(opts === undefined ? { cmd } : { cmd, opts: { ...opts } });
    const programmed = this.execResults.shift();
    if (programmed !== undefined) return programmed;

    const printedEnv = /^printf\s+'%s'\s+"\$([A-Za-z_][A-Za-z0-9_]*)"$/.exec(cmd)?.[1];
    if (printedEnv !== undefined) {
      return { code: 0, stdout: this.env[printedEnv] ?? "", stderr: "" };
    }

    const fetchedHost = /fetch\(['"]https:\/\/([^/'"]+)/.exec(cmd)?.[1];
    if (fetchedHost !== undefined) {
      const allowed = this.egress === undefined || this.egress.some((rule) =>
        rule === fetchedHost || (rule.startsWith("*.") && fetchedHost.endsWith(rule.slice(1))));
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
    return this.saveSnapshot(this);
  }

  async screenshot(): Promise<Uint8Array> {
    return onePixelPng.slice();
  }

  async url(port: number): Promise<string> {
    return `http://fake-machine-${this.id}.local:${port}`;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

export interface FakeSandboxAdapter extends SandboxAdapter {
  readonly machines: Map<string, FakeSandboxMachine>;
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
      ...(machine.egress === undefined ? {} : { egress: Object.freeze([...machine.egress]) }),
      files: new Map([...machine.fileContents].map(([path, bytes]) => [path, bytes.slice()])),
      app: machine.app,
    }));
    return ref;
  };

  const makeMachine = (
    env: Record<string, string>,
    egress: readonly string[] | undefined,
    files: ReadonlyMap<string, Uint8Array>,
    app?: MachineApp,
  ): FakeSandboxMachine => {
    const id = String(nextProviderMachine++);
    const machine = new FakeSandboxMachine(
      id,
      env,
      egress === undefined ? undefined : Object.freeze([...egress]),
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
    async create(spec): Promise<FakeSandboxMachine> {
      const files = new Map<string, Uint8Array>();
      for (const [path, bytes] of Object.entries(spec.files ?? {})) files.set(path, toBytes(bytes));
      return makeMachine(spec.env, spec.egress, files, installedApp);
    },
    async resume(snapshotRef): Promise<FakeSandboxMachine> {
      const snapshot = providerSnapshots.get(snapshotRef);
      if (snapshot === undefined) throw new Error(`Unknown fake sandbox snapshot: ${snapshotRef}`);
      return makeMachine({ ...snapshot.env }, snapshot.egress, snapshot.files, snapshot.app);
    },
  };
};
