import { describe, expect, it } from "vitest";
import { runSync } from "./sync.js";

const report = (breaking: Array<{ tool: string; change: "removed" }> = []) => ({
  tools: { added: [], removed: [], changed: [] },
  breaking,
  pins: { captured: [], drifted: [] },
  warnings: [],
});

describe("vendo sync", () => {
  it("fails soft by default and exits two for strict breaking changes", async () => {
    const output = { log() {}, error() {} };
    expect(await runSync({ targetDir: ".", output, sync: async () => { throw new Error("scan"); } })).toBe(0);
    expect(await runSync({ targetDir: ".", strict: true, output, sync: async () => report([{ tool: "host_x", change: "removed" }]) })).toBe(2);
    expect(await runSync({ targetDir: ".", output, sync: async () => report([{ tool: "host_x", change: "removed" }]) })).toBe(0);
  });
});
