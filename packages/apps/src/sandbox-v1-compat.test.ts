import { describe, expect, it, vi } from "vitest";
import type { SandboxAdapter, SandboxMachine } from "./sandbox.js";
import { toV1SandboxAdapter, type V1SandboxAdapter } from "./sandbox-v1-compat.js";

/** A strictly v2-only machine: the public seam and nothing else. */
const v2OnlyMachine = (): SandboxMachine & { destroyed: boolean; slept: boolean } => {
  const machine = {
    id: "v2_only",
    destroyed: false,
    slept: false,
    async request() {
      return { status: 200, headers: {}, body: new Uint8Array() };
    },
    async snapshot() {
      return "v2:snap";
    },
    async stop() {
      machine.slept = true;
    },
    async destroy() {
      machine.destroyed = true;
    },
  };
  return machine;
};

describe("toV1SandboxAdapter", () => {
  it("republishes the v1 egress list as the v2 spec's allowedDomains", async () => {
    const create = vi.fn(async () => v2OnlyMachine());
    const adapter: SandboxAdapter = { create, resume: async () => v2OnlyMachine() };
    await toV1SandboxAdapter(adapter).create({ env: {}, egress: ["api.example.com"] });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      allowedDomains: ["api.example.com"],
      egress: ["api.example.com"],
    }));
  });

  it("maps v1 stop() to v2 destroy() so teardown never strands a paused machine", async () => {
    const machine = v2OnlyMachine();
    const bridged = await toV1SandboxAdapter({
      create: async () => machine,
      resume: async () => machine,
    }).create({ env: {} });
    await bridged.stop();
    expect(machine.destroyed).toBe(true);
    expect(machine.slept).toBe(false);
  });

  it("fails loudly at access when a v2-only machine is asked for adapter-private exec/files", async () => {
    const bridged = await toV1SandboxAdapter({
      create: async () => v2OnlyMachine(),
      resume: async () => v2OnlyMachine(),
    }).create({ env: {} });
    expect(() => bridged.exec).toThrow(/adapter-private exec/);
    expect(() => bridged.files).toThrow(/adapter-private files/);
  });

  it("passes a v1-native machine through untouched, stop semantics included", async () => {
    let stopped = false;
    const v1Machine = {
      id: "v1_native",
      async request() {
        return { status: 200, headers: {}, body: new Uint8Array() };
      },
      async exec() {
        return { code: 0, stdout: "", stderr: "" };
      },
      files: {
        async read() {
          return new Uint8Array();
        },
        async write() {
          /* no-op */
        },
        async list() {
          return [];
        },
      },
      async snapshot() {
        return "v1:snap";
      },
      async stop() {
        stopped = true;
      },
    };
    const adapter: V1SandboxAdapter = {
      create: async () => v1Machine,
      resume: async () => v1Machine,
    };
    const bridged = await toV1SandboxAdapter(adapter).create({ env: {} });
    expect(bridged).toBe(v1Machine);
    await bridged.stop();
    expect(stopped).toBe(true);
  });
});
