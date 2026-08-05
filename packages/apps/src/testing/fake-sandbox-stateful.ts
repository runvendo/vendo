import { VendoError } from "@vendoai/core";
import type { SandboxAdapter, SandboxMachine } from "../sandbox.js";
import { inMemoryBoxFiles } from "./box-files.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const respond = (
  status: number,
  body: string,
): { status: number; headers: Record<string, string>; body: Uint8Array } => ({
  status,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body: textEncoder.encode(body),
});

interface FakeStatefulSnapshot {
  env: Readonly<Record<string, string>>;
  /** The create-time egress allowlist the snapshot carries (like real refs). */
  allowedDomains?: readonly string[];
  template?: string;
  state: ReadonlyMap<string, string>;
  files: ReadonlyMap<string, Uint8Array>;
}

/**
 * Execution-v2 fake machine. Its only observable box state is a key-value map
 * mutated over HTTP (`POST /state/<key>` writes the body, `GET /state/<key>`
 * reads it back), so lifecycle tests can prove a snapshot/resume cycle
 * preserves what ran inside the box.
 */
export class FakeStatefulMachine implements SandboxMachine {
  stopped = false;
  /** True after the live-machine destroy() (distinct from a snapshot-preserving stop). */
  destroyedSelf = false;
  /** True after the PROVIDER reaped the machine out from under us (TTL, sweep). */
  reaped = false;
  readonly env: Readonly<Record<string, string>>;
  readonly state: Map<string, string>;
  /** The box's disk, beside its key-value state: a snapshot/resume cycle
   *  carries both, so a lifecycle test can prove the app's SOURCE survived. */
  readonly fileContents: Map<string, Uint8Array>;
  readonly files: SandboxMachine["files"];

  constructor(
    readonly id: string,
    env: Record<string, string>,
    readonly allowedDomains: readonly string[] | undefined,
    readonly template: string | undefined,
    state: ReadonlyMap<string, string>,
    files: ReadonlyMap<string, Uint8Array>,
    private readonly saveSnapshot: (machine: FakeStatefulMachine) => string,
  ) {
    this.env = Object.freeze({ ...env });
    this.state = new Map(state);
    this.fileContents = new Map([...files].map(([path, bytes]) => [path, bytes.slice()]));
    this.files = inMemoryBoxFiles(this.fileContents);
  }

  async request(req: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
  }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
    // The seam's dead-machine signal (sandbox.ts): provider state gone under a
    // live handle throws VendoError not-found, never an app-level status.
    if (this.reaped) throw new VendoError("not-found", `fake stateful machine ${this.id} was reaped by the provider`);
    if (this.stopped) throw new Error(`fake stateful machine ${this.id} is stopped`);
    const key = /^\/state\/([A-Za-z0-9_-]+)$/.exec(req.path)?.[1];
    if (key !== undefined) {
      if (req.method.toUpperCase() === "POST") {
        this.state.set(
          key,
          typeof req.body === "string" ? req.body : textDecoder.decode(req.body ?? new Uint8Array()),
        );
        return respond(204, "");
      }
      const value = this.state.get(key);
      return value === undefined ? respond(404, "") : respond(200, value);
    }
    return respond(200, "ok");
  }

  async url(port?: number): Promise<string> {
    const target = port ?? Number(this.env.PORT ?? 8080);
    return `https://${target}-${this.id}.fake-stateful.test`;
  }

  async snapshot(): Promise<string> {
    return this.saveSnapshot(this);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  /** Live-machine destroy: gone for good; previously taken snapshot refs stay valid. */
  async destroy(): Promise<void> {
    this.stopped = true;
    this.destroyedSelf = true;
  }

  /** Simulate the PROVIDER killing the machine (TTL expiry, idle sweep). */
  reap(): void {
    this.reaped = true;
  }
}

export interface FakeStatefulSandbox extends SandboxAdapter {
  /** Every machine this adapter ever booted, in boot order. */
  readonly machines: FakeStatefulMachine[];
  /** Live provider-side snapshots (destroy removes its ref from here). */
  readonly snapshots: Map<string, FakeStatefulSnapshot>;
  /** Refs passed to destroy, in call order. */
  readonly destroyed: string[];
  creates: number;
  resumes: number;
}

/** In-process SandboxAdapter with inspectable machines, snapshots, and destroys. */
export const fakeStatefulSandbox = (): FakeStatefulSandbox => {
  const machines: FakeStatefulMachine[] = [];
  const snapshots = new Map<string, FakeStatefulSnapshot>();
  const destroyed: string[] = [];
  let nextMachine = 1;
  let nextSnapshot = 1;

  const saveSnapshot = (machine: FakeStatefulMachine): string => {
    const ref = `fake-v2:snap_${nextSnapshot++}`;
    snapshots.set(ref, Object.freeze({
      env: machine.env,
      ...(machine.allowedDomains === undefined ? {} : { allowedDomains: Object.freeze([...machine.allowedDomains]) }),
      ...(machine.template === undefined ? {} : { template: machine.template }),
      state: new Map(machine.state),
      files: new Map([...machine.fileContents].map(([path, bytes]) => [path, bytes.slice()])),
    }));
    return ref;
  };

  const boot = (
    env: Record<string, string>,
    allowedDomains: readonly string[] | undefined,
    template: string | undefined,
    state: ReadonlyMap<string, string>,
    files: ReadonlyMap<string, Uint8Array>,
  ): FakeStatefulMachine => {
    const machine = new FakeStatefulMachine(
      `fake-machine-${nextMachine++}`,
      env,
      allowedDomains === undefined ? undefined : Object.freeze([...allowedDomains]),
      template,
      state,
      files,
      saveSnapshot,
    );
    machines.push(machine);
    return machine;
  };

  const adapter: FakeStatefulSandbox = {
    machines,
    snapshots,
    destroyed,
    creates: 0,
    resumes: 0,
    async create(spec) {
      adapter.creates += 1;
      return boot(spec.env, spec.allowedDomains, spec.template, new Map(), new Map());
    },
    async resume(snapshotRef, policy) {
      adapter.resumes += 1;
      const snapshot = snapshots.get(snapshotRef);
      if (snapshot === undefined) throw new Error(`unknown fake stateful snapshot: ${snapshotRef}`);
      // Lane E — a passed policy replaces the snapshot-time allowlist (seam rule).
      const allowedDomains = policy === undefined ? snapshot.allowedDomains : policy.allowedDomains;
      return boot({ ...snapshot.env }, allowedDomains, snapshot.template, snapshot.state, snapshot.files);
    },
    async destroy(snapshotRef) {
      destroyed.push(snapshotRef);
      snapshots.delete(snapshotRef);
    },
  };
  return adapter;
};
