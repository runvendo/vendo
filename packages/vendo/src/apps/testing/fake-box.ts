import type { SandboxAdapter, SandboxMachine } from "../../sandbox/escalation/sandbox.js";
import { inMemoryBoxFiles } from "./box-files.js";

/**
 * The persistent-machine simulation (in-box agent, control port, fn dispatch,
 * manifest, served pages, snapshot/resume) is gone with the graduation lane.
 * What remains is the smallest SandboxAdapter whose `files` seam is guarded by
 * machine lifecycle — which is all its one consumer (box-files.test.ts)
 * measures. The shared fakeSandbox stays the full-featured fake.
 */

let nextId = 1;

export interface FakeBoxAdapter extends SandboxAdapter {
  /** Every machine this adapter created (for assertions on live/torn-down state). */
  readonly machines: FakeBoxMachine[];
}

class FakeBoxMachine implements SandboxMachine {
  readonly id = `box-${nextId++}`;
  destroyed = false;
  stopped = false;

  /** The seam's file operations (sandbox.ts), over the box's own disk. */
  readonly files: SandboxMachine["files"];

  constructor() {
    this.files = inMemoryBoxFiles(new Map(), (operation) => {
      if (this.destroyed || this.stopped) throw new Error(`box ${this.id} is not running; cannot ${operation}`);
    });
  }

  async request(): Promise<never> {
    throw new Error(`box ${this.id} serves nothing: this fake keeps only the files seam`);
  }

  async url(): Promise<never> {
    throw new Error(`box ${this.id} serves nothing: this fake keeps only the files seam`);
  }

  async snapshot(): Promise<never> {
    throw new Error(`box ${this.id} does not snapshot: this fake keeps only the files seam`);
  }

  async stop(): Promise<void> { this.stopped = true; }
  async destroy(): Promise<void> { this.destroyed = true; this.stopped = true; }
}

export const fakeBoxSandbox = (): FakeBoxAdapter => {
  const machines: FakeBoxMachine[] = [];
  return {
    machines,
    async create() {
      const machine = new FakeBoxMachine();
      machines.push(machine);
      return machine;
    },
    async resume(snapshotRef) {
      throw new Error(`unknown fake-box snapshot: ${snapshotRef}`);
    },
    async destroy(snapshotRef) {
      if (!snapshotRef.startsWith("fakebox:")) throw new Error(`not a fake-box ref: ${snapshotRef}`);
    },
  };
};
