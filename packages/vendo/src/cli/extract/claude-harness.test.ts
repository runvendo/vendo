import { describe, expect, it } from "vitest";
import { claudeHarness } from "./claude-harness.js";

const SDK = (messages: Array<Record<string, unknown>>) => ({
  query: () => (async function* () {
    for (const message of messages) yield message;
  })(),
});

describe("claudeHarness", () => {
  it("is unavailable without the SDK, regardless of credentials", async () => {
    const harness = claudeHarness({ loadSdk: async () => null, probeLogin: async () => true });
    expect(await harness.availability({ root: "/x", env: { ANTHROPIC_API_KEY: "sk" } })).toBeNull();
  });

  it("prefers the env key label, then the Claude Code login", async () => {
    const withSdk = { loadSdk: async () => SDK([]) };
    expect(await claudeHarness({ ...withSdk, probeLogin: async () => false })
      .availability({ root: "/x", env: { ANTHROPIC_API_KEY: "sk" } })).toBe("your ANTHROPIC_API_KEY");
    expect(await claudeHarness({ ...withSdk, probeLogin: async () => true })
      .availability({ root: "/x", env: {} })).toBe("your Claude Code login");
    expect(await claudeHarness({ ...withSdk, probeLogin: async () => false })
      .availability({ root: "/x", env: {} })).toBeNull();
  });

  it("returns the final result text and narrates tool use", async () => {
    const harness = claudeHarness({
      loadSdk: async () => SDK([
        { type: "assistant", message: { content: [
          { type: "tool_use", name: "Read", input: { file_path: "app/api/invoices/route.ts" } },
          { type: "text", text: "thinking…" },
        ] } },
        { type: "result", result: '{"brief":"b","tools":[]}' },
      ]),
    });
    const progress: string[] = [];
    const text = await harness.run({
      root: "/x",
      env: {},
      instructions: "go",
      onProgress: (line) => progress.push(line),
    });
    expect(text).toBe('{"brief":"b","tools":[]}');
    expect(progress).toEqual(["read app/api/invoices/route.ts"]);
  });

  it("falls back to concatenated assistant text when no result message arrives", async () => {
    const harness = claudeHarness({
      loadSdk: async () => SDK([
        { type: "assistant", message: { content: [{ type: "text", text: '{"brief":"b",' }] } },
        { type: "assistant", message: { content: [{ type: "text", text: '"tools":[]}' }] } },
      ]),
    });
    expect(await harness.run({ root: "/x", env: {}, instructions: "go" })).toBe('{"brief":"b",\n"tools":[]}');
  });
});
