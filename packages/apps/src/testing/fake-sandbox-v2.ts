import type { SandboxAdapterV2, SandboxMachineV2 } from "../sandbox-v2.js";

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

interface FakeSnapshotV2 {
  env: Readonly<Record<string, string>>;
  template?: string;
  state: ReadonlyMap<string, string>;
}

/**
 * Execution-v2 fake machine. Its only observable box state is a key-value map
 * mutated over HTTP (`POST /state/<key>` writes the body, `GET /state/<key>`
 * reads it back), so lifecycle tests can prove a snapshot/resume cycle
 * preserves what ran inside the box.
 */
export class FakeMachineV2 implements SandboxMachineV2 {
  stopped = false;
  /** True after the live-machine destroy() (distinct from a snapshot-preserving stop). */
  destroyedSelf = false;
  readonly env: Readonly<Record<string, string>>;
  readonly state: Map<string, string>;

  constructor(
    readonly id: string,
    env: Record<string, string>,
    readonly template: string | undefined,
    state: ReadonlyMap<string, string>,
    private readonly saveSnapshot: (machine: FakeMachineV2) => string,
  ) {
    this.env = Object.freeze({ ...env });
    this.state = new Map(state);
  }

  async request(req: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
  }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
    if (this.stopped) throw new Error(`fake v2 machine ${this.id} is stopped`);
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
}

export interface FakeSandboxV2 extends SandboxAdapterV2 {
  /** Every machine this adapter ever booted, in boot order. */
  readonly machines: FakeMachineV2[];
  /** Live provider-side snapshots (destroy removes its ref from here). */
  readonly snapshots: Map<string, FakeSnapshotV2>;
  /** Refs passed to destroy, in call order. */
  readonly destroyed: string[];
  creates: number;
  resumes: number;
}

/** In-process SandboxAdapterV2 with inspectable machines, snapshots, and destroys. */
export const fakeSandboxV2 = (): FakeSandboxV2 => {
  const machines: FakeMachineV2[] = [];
  const snapshots = new Map<string, FakeSnapshotV2>();
  const destroyed: string[] = [];
  let nextMachine = 1;
  let nextSnapshot = 1;

  const saveSnapshot = (machine: FakeMachineV2): string => {
    const ref = `fake-v2:snap_${nextSnapshot++}`;
    snapshots.set(ref, Object.freeze({
      env: machine.env,
      ...(machine.template === undefined ? {} : { template: machine.template }),
      state: new Map(machine.state),
    }));
    return ref;
  };

  const boot = (
    env: Record<string, string>,
    template: string | undefined,
    state: ReadonlyMap<string, string>,
  ): FakeMachineV2 => {
    const machine = new FakeMachineV2(
      `fake-machine-${nextMachine++}`,
      env,
      template,
      state,
      saveSnapshot,
    );
    machines.push(machine);
    return machine;
  };

  const adapter: FakeSandboxV2 = {
    machines,
    snapshots,
    destroyed,
    creates: 0,
    resumes: 0,
    async create(spec) {
      adapter.creates += 1;
      return boot(spec.env, spec.template, new Map());
    },
    async resume(snapshotRef) {
      adapter.resumes += 1;
      const snapshot = snapshots.get(snapshotRef);
      if (snapshot === undefined) throw new Error(`unknown fake v2 snapshot: ${snapshotRef}`);
      return boot({ ...snapshot.env }, snapshot.template, snapshot.state);
    },
    async destroy(snapshotRef) {
      destroyed.push(snapshotRef);
      snapshots.delete(snapshotRef);
    },
  };
  return adapter;
};
