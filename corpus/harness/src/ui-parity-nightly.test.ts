import { describe, expect, it } from "vitest";
import { resolveModel, runUiParityNightly } from "./ui-parity-nightly.js";

describe("runUiParityNightly", () => {
  it("skips gracefully (exit 0) when the ai-SDK cannot be resolved", async () => {
    const logs: string[] = [];
    const code = await runUiParityNightly([], {}, (line) => logs.push(line), {
      resolveModel: async () => {
        throw new Error("ai-SDK not available (Cannot find module 'ai'); install `ai` and `@ai-sdk/anthropic`.");
      },
    });
    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("ui-parity audit skipped");
    expect(output).toContain("ai-SDK not available");
  });

  it("skips gracefully when the model resolver rejects for a missing key", async () => {
    const logs: string[] = [];
    const code = await runUiParityNightly([], {}, (line) => logs.push(line), {
      resolveModel: (env) => resolveModel(env),
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("ANTHROPIC_API_KEY");
  });

  it("resolveModel throws a clear error when ANTHROPIC_API_KEY is absent", async () => {
    await expect(resolveModel({})).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
