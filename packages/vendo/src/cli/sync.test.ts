import { describe, expect, it } from "vitest";
import { runSync } from "./sync.js";

const report = (breaking: Array<{ tool: string; change: "removed" }> = []) => ({
  tools: { added: [], removed: [], changed: [] },
  breaking,
  pins: { captured: [], drifted: [] },
  unresolvedPins: [],
  warnings: [],
});

describe("vendo sync", () => {
  it("fails soft by default and exits two for strict breaking changes", async () => {
    const output = { log() {}, error() {} };
    expect(await runSync({ targetDir: ".", output, sync: async () => { throw new Error("scan"); } })).toBe(0);
    expect(await runSync({ targetDir: ".", strict: true, output, sync: async () => report([{ tool: "host_x", change: "removed" }]) })).toBe(2);
    expect(await runSync({ targetDir: ".", output, sync: async () => report([{ tool: "host_x", change: "removed" }]) })).toBe(0);
  });

  it("exits two and lists every unresolved remixable slot", async () => {
    const errors: string[] = [];
    const output = { log() {}, error(message: string) { errors.push(message); } };
    const unresolved = {
      ...report(),
      unresolvedPins: [{
        slot: "InlineCard",
        component: "() => null",
        reason: "inline-component" as const,
        hint: "run the host in dev with Vendo mounted to runtime-capture it",
      }],
    };
    expect(await runSync({ targetDir: ".", output, sync: async () => unresolved })).toBe(2);
    expect(errors.join("\n")).toContain("InlineCard [inline-component]");
    expect(errors.join("\n")).toContain("run the host in dev with Vendo mounted to runtime-capture it");
  });
});
