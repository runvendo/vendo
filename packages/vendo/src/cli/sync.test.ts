import { describe, expect, it, vi } from "vitest";
import { runSync } from "./sync.js";

const report = (
  breaking: Array<{ tool: string; change: "removed" }> = [],
  changed: string[] = [],
) => ({
  tools: { added: [], removed: [], changed },
  breaking,
  pins: { captured: [], drifted: [] },
  warnings: [],
});

function captureOutput(): { output: { log(message: string): void; error(message: string): void }; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    output: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
    logs,
    errors,
  };
}

describe("vendo sync", () => {
  it("fails soft by default and exits two for strict breaking changes", async () => {
    const output = { log() {}, error() {} };
    const fetchImpl = async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [], automations: [], grants: 0 }],
    }), { status: 200 });
    expect(await runSync({ targetDir: ".", output, sync: async () => { throw new Error("scan"); } })).toBe(0);
    expect(await runSync({ targetDir: ".", strict: true, output, fetchImpl, sync: async () => report([{ tool: "host_x", change: "removed" }]) })).toBe(2);
    expect(await runSync({ targetDir: ".", output, fetchImpl, sync: async () => report([{ tool: "host_x", change: "removed" }]) })).toBe(0);
  });

  it("queries changed and breaking tools and prints per-tool impact", async () => {
    const messages = captureOutput();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [
        {
          tool: "host_x",
          apps: [{ id: "app_x", title: "X" }],
          automations: [{ id: "app_a", title: "A" }, { id: "app_b", title: "B" }],
          grants: 3,
        },
        { tool: "host_y", apps: [], automations: [], grants: 0 },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    await runSync({
      targetDir: ".",
      output: messages.output,
      url: "http://dev.test/api/vendo/",
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }], ["host_x", "host_y"]),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith("http://dev.test/api/vendo/sync/impact", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ tools: ["host_x", "host_y"] }),
    });
    expect(messages.logs).toContain("impact: host_x breaks 2 automations, 1 app, 3 grants");
    expect(messages.logs).toContain("impact: host_y no saved references");
  });

  it("falls back when impact is unreachable and keeps strict exit two", async () => {
    const messages = captureOutput();
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); }) as typeof fetch;

    const exit = await runSync({
      targetDir: ".",
      strict: true,
      output: messages.output,
      url: "http://offline.test/api/vendo",
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
    });

    expect(exit).toBe(2);
    expect(messages.logs).toContain("impact unknown — dev server not reachable at http://offline.test/api/vendo");
  });

  it("returns strict exit three when a breaking tool has nonzero impact", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [], automations: [{ id: "app_a", title: "A" }], grants: 0 }],
    }), { status: 200 })) as typeof fetch;

    await expect(runSync({
      targetDir: ".",
      strict: true,
      output: captureOutput().output,
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
    })).resolves.toBe(3);
  });

  it("keeps strict exit two when breaking tools have zero impact", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      impact: [{ tool: "host_x", apps: [], automations: [], grants: 0 }],
    }), { status: 200 })) as typeof fetch;

    await expect(runSync({
      targetDir: ".",
      strict: true,
      output: captureOutput().output,
      fetchImpl,
      sync: async () => report([{ tool: "host_x", change: "removed" }]),
    })).resolves.toBe(2);
  });

  it("does not query impact when there are no changed or breaking tools", async () => {
    const fetchImpl = vi.fn() as typeof fetch;

    await expect(runSync({
      targetDir: ".",
      strict: true,
      output: captureOutput().output,
      fetchImpl,
      sync: async () => report(),
    })).resolves.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
