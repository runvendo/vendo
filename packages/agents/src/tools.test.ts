import type { RunContext, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { mergeSources, tool } from "./tools.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "u_1" },
  venue: "chat",
  presence: "present",
  sessionId: "thr_t",
};

const registryOf = (...names: string[]): ToolRegistry => ({
  async descriptors() {
    return names.map((name) => ({
      name,
      description: "",
      inputSchema: { type: "object" as const },
      risk: "read" as const,
    }));
  },
  async execute(call) {
    return { status: "ok", output: { from: call.tool } };
  },
});

describe("tool()", () => {
  it("unlabeled = ungraded — the guard asks; it is never invented as a grade", () => {
    const t = tool({ name: "lookup", inputSchema: { type: "object" }, execute: () => ({}) });
    expect(t.descriptor.risk).toBe("ungraded");
  });

  it("keeps the dev's label — it is final", () => {
    const t = tool({ name: "wipe", risk: "destructive", inputSchema: { type: "object" }, execute: () => ({}) });
    expect(t.descriptor.risk).toBe("destructive");
  });

  it("rejects a name the registry could never carry", () => {
    expect(() => tool({ name: "not a name!", inputSchema: { type: "object" }, execute: () => ({}) }))
      .toThrow(/must match/);
  });
});

describe("mergeSources", () => {
  it("executes a host tool and wraps its output / its throw", async () => {
    const merged = mergeSources(
      [
        tool({ name: "ok", risk: "read", inputSchema: { type: "object" }, execute: (input) => ({ echoed: input }) }),
        tool({ name: "boom", risk: "read", inputSchema: { type: "object" }, execute: () => { throw new Error("nope"); } }),
      ],
      [],
    );
    expect(await merged.execute({ id: "c1", tool: "ok", args: { a: 1 } }, ctx))
      .toEqual({ status: "ok", output: { echoed: { a: 1 } } });
    const failed = await merged.execute({ id: "c2", tool: "boom", args: {} }, ctx);
    expect(failed.status).toBe("error");
  });

  it("routes across sources by name and answers not-found honestly", async () => {
    const merged = mergeSources(
      [tool({ name: "mine", risk: "read", inputSchema: { type: "object" }, execute: () => ({}) }), registryOf("theirs")],
      [],
    );
    expect((await merged.execute({ id: "c1", tool: "theirs", args: {} }, ctx)).status).toBe("ok");
    expect((await merged.execute({ id: "c2", tool: "missing", args: {} }, ctx)).status).toBe("error");
  });

  it("two tool() names colliding is a boot error, synchronously", () => {
    const a = tool({ name: "same", inputSchema: { type: "object" }, execute: () => ({}) });
    const b = tool({ name: "same", inputSchema: { type: "object" }, execute: () => ({}) });
    expect(() => mergeSources([a, b], [])).toThrow(/claim the name "same"/);
  });

  it("a dynamic source colliding throws on the first projection — before any call can shadow", async () => {
    const merged = mergeSources(
      [tool({ name: "same", inputSchema: { type: "object" }, execute: () => ({}) }), registryOf("same")],
      [],
    );
    await expect(merged.descriptors()).rejects.toThrow(/claim the name "same"/);
  });

  it("projects every source's descriptors together", async () => {
    const merged = mergeSources(
      [tool({ name: "a", inputSchema: { type: "object" }, execute: () => ({}) }), registryOf("b", "c")],
      [],
    );
    expect((await merged.descriptors()).map((d) => d.name).sort()).toEqual(["a", "b", "c"]);
  });
});
