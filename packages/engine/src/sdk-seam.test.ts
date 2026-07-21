import { describe, expect, it } from "vitest";
import { adapt } from "./sdk-seam.js";

async function* streamOf(...messages: Record<string, unknown>[]): AsyncGenerator<Record<string, unknown>> {
  for (const m of messages) yield m;
}

async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

describe("adapt (raw SDK message stream -> EngineMessage)", () => {
  it("yields a progress message for assistant text blocks", async () => {
    const raw = { type: "assistant", message: { content: [{ type: "text", text: "thinking about it" }] } };
    await expect(collect(adapt(streamOf(raw)))).resolves.toEqual([{ kind: "progress", text: "thinking about it" }]);
  });

  it("drops empty assistant text blocks", async () => {
    const raw = { type: "assistant", message: { content: [{ type: "text", text: "" }] } };
    await expect(collect(adapt(streamOf(raw)))).resolves.toEqual([]);
  });

  it("yields a progress message naming the tool and its file_path target", async () => {
    const raw = { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/index.ts" } }] } };
    await expect(collect(adapt(streamOf(raw)))).resolves.toEqual([{ kind: "progress", text: "Read src/index.ts" }]);
  });

  it("yields a progress message naming the tool and its glob pattern target", async () => {
    const raw = { type: "assistant", message: { content: [{ type: "tool_use", name: "Glob", input: { pattern: "**/*.ts" } }] } };
    await expect(collect(adapt(streamOf(raw)))).resolves.toEqual([{ kind: "progress", text: "Glob **/*.ts" }]);
  });

  it("yields just the tool name when tool_use carries no recognizable target", async () => {
    const raw = { type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: {} }] } };
    await expect(collect(adapt(streamOf(raw)))).resolves.toEqual([{ kind: "progress", text: "Grep" }]);
  });

  it("handles multiple content blocks in one assistant message", async () => {
    const raw = {
      type: "assistant",
      message: { content: [{ type: "text", text: "checking" }, { type: "tool_use", name: "Read", input: { file_path: "a.ts" } }] },
    };
    await expect(collect(adapt(streamOf(raw)))).resolves.toEqual([
      { kind: "progress", text: "checking" },
      { kind: "progress", text: "Read a.ts" },
    ]);
  });

  it("yields success from a result message and stops (does not read past it)", async () => {
    let readAfter = false;
    async function* gen() {
      yield { type: "result", subtype: "success", result: "the final answer" };
      readAfter = true;
      yield { type: "assistant", message: { content: [] } };
    }
    await expect(collect(adapt(gen()))).resolves.toEqual([{ kind: "success", text: "the final answer" }]);
    expect(readAfter).toBe(false);
  });

  it("yields failure with the error subtype's errors array", async () => {
    const raw = { type: "result", subtype: "error_max_turns", errors: ["ran out of turns"] };
    await expect(collect(adapt(streamOf(raw)))).resolves.toEqual([{ kind: "failure", errors: ["ran out of turns"] }]);
  });

  it("synthesizes an error message from the subtype when errors is missing or malformed", async () => {
    await expect(collect(adapt(streamOf({ type: "result", subtype: "error_max_budget_usd" })))).resolves.toEqual([
      { kind: "failure", errors: ["engine error_max_budget_usd"] },
    ]);
    await expect(collect(adapt(streamOf({ type: "result", subtype: "error_during_execution", errors: "not an array" })))).resolves.toEqual([
      { kind: "failure", errors: ["engine error_during_execution"] },
    ]);
  });

  it("yields nothing for message types it doesn't recognize", async () => {
    await expect(collect(adapt(streamOf({ type: "system", subtype: "init" })))).resolves.toEqual([]);
  });
});
