import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Json, RunContext, ToolRegistry } from "@vendoai/core";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { api, mergeSources, tool } from "../src/tools.js";

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
    const t = tool({ name: "lookup", description: "Look one up", inputSchema: { type: "object" }, execute: () => ({}) });
    expect(t.descriptor.risk).toBe("ungraded");
  });

  it("keeps the dev's label — it is final", () => {
    const t = tool({ name: "wipe", description: "Wipe it", risk: "destructive", inputSchema: { type: "object" }, execute: () => ({}) });
    expect(t.descriptor.risk).toBe("destructive");
  });

  it("carries the declared result shape, and has no key at all without one", () => {
    const outputSchema = { type: "object" as const, properties: { balance: { type: "number" } } };
    const declared = tool({ name: "balance", description: "Read the balance", inputSchema: { type: "object" }, outputSchema, execute: () => ({}) });
    expect(declared.descriptor.outputSchema).toEqual(outputSchema);
    const silent = tool({ name: "ping", description: "Ping", inputSchema: { type: "object" }, execute: () => ({}) });
    expect("outputSchema" in silent.descriptor).toBe(false);
  });

  it("rejects a name the registry could never carry", () => {
    expect(() => tool({ name: "not a name!", description: "Nope", inputSchema: { type: "object" }, execute: () => ({}) }))
      .toThrow(/must match/);
  });

  it("refuses a tool with nothing to tell the model, and says what to write", () => {
    // As an untyped host would call it — the type says required, this says so at runtime too.
    const missing: unknown = { name: "lookup", inputSchema: { type: "object" }, execute: () => ({}) };
    expect(() => tool(missing as Parameters<typeof tool>[0]))
      .toThrow(/needs a description[\s\S]*write a sentence/);
    expect(() => tool({ name: "lookup", description: "   ", inputSchema: { type: "object" }, execute: () => ({}) }))
      .toThrow(/needs a description/);
  });

  it("takes a zod schema: `execute` is typed by it, and the descriptor carries its JSON Schema", () => {
    const refund = tool({
      name: "refund",
      description: "Refund an order in full.",
      inputSchema: z.object({ orderId: z.string(), note: z.string().optional() }),
      execute: (input) => {
        expectTypeOf(input).toEqualTypeOf<{ orderId: string; note?: string | undefined }>();
        return { refunded: input.orderId };
      },
    });
    expect(refund.descriptor.inputSchema).toMatchObject({
      type: "object",
      properties: { orderId: { type: "string" }, note: { type: "string" } },
      required: ["orderId"],
    });
  });

  it("takes a raw JSON Schema unchanged — and then `input` is only Json", () => {
    const inputSchema = { type: "object" as const, properties: { orderId: { type: "string" } } };
    const refund = tool({
      name: "refund_raw",
      description: "Refund an order in full.",
      inputSchema,
      execute: (input) => {
        expectTypeOf(input).toEqualTypeOf<Json>();
        return {};
      },
    });
    expect(refund.descriptor.inputSchema).toBe(inputSchema);
  });
});

/** A host root carrying one extracted route tool, made the working directory
 *  so a bare `api()` sees it the way a backend host's process would. */
async function hostRootWithOneTool(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-agents-api-"));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, ".vendo"));
  await fs.writeFile(
    path.join(root, ".vendo", "tools.json"),
    JSON.stringify({
      format: "vendo/tools@3",
      tools: [{
        name: "host_ping",
        description: "Ping",
        inputSchema: { type: "object" },
        risk: "read",
        binding: { kind: "route", method: "GET", path: "/api/ping", argsIn: "query" },
      }],
    }),
    "utf8",
  );
  process.chdir(root);
}

const temporaryRoots: string[] = [];
const startingDirectory = process.cwd();

afterEach(async () => {
  process.chdir(startingDirectory);
  delete process.env["VENDO_BASE_URL"];
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("api()", () => {
  it("reads the host's tools from ./.vendo with nothing passed", async () => {
    await hostRootWithOneTool();
    expect((await api().descriptors(ctx)).map((d) => d.name)).toEqual(["host_ping"]);
  });

  it("dials the origin VENDO_BASE_URL names when no baseUrl is passed", async () => {
    await hostRootWithOneTool();
    process.env["VENDO_BASE_URL"] = "https://app.example.test";
    const dialed: string[] = [];
    const registry = api({
      fetch: async (input) => {
        dialed.push(String(input));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await registry.execute({ id: "c1", tool: "host_ping", args: {} }, ctx);
    expect(dialed).toEqual(["https://app.example.test/api/ping"]);
  });
});

describe("mergeSources", () => {
  it("executes a host tool and wraps its output / its throw", async () => {
    const merged = mergeSources(
      [
        tool({ name: "ok", description: "Echo the input", risk: "read", inputSchema: { type: "object" }, execute: (input) => ({ echoed: input }) }),
        tool({ name: "boom", description: "Throw", risk: "read", inputSchema: { type: "object" }, execute: () => { throw new Error("nope"); } }),
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
      [tool({ name: "mine", description: "Mine", risk: "read", inputSchema: { type: "object" }, execute: () => ({}) }), registryOf("theirs")],
      [],
    );
    expect((await merged.execute({ id: "c1", tool: "theirs", args: {} }, ctx)).status).toBe("ok");
    expect((await merged.execute({ id: "c2", tool: "missing", args: {} }, ctx)).status).toBe("error");
  });

  it("two tool() names colliding is a boot error, synchronously", () => {
    const a = tool({ name: "same", description: "Same name", inputSchema: { type: "object" }, execute: () => ({}) });
    const b = tool({ name: "same", description: "Same name", inputSchema: { type: "object" }, execute: () => ({}) });
    expect(() => mergeSources([a, b], [])).toThrow(/claim the name "same"/);
  });

  it("a dynamic source colliding throws on the first projection — before any call can shadow", async () => {
    const merged = mergeSources(
      [tool({ name: "same", description: "Same name", inputSchema: { type: "object" }, execute: () => ({}) }), registryOf("same")],
      [],
    );
    await expect(merged.descriptors()).rejects.toThrow(/claim the name "same"/);
  });

  it("projects every source's descriptors together", async () => {
    const merged = mergeSources(
      [tool({ name: "a", description: "A", inputSchema: { type: "object" }, execute: () => ({}) }), registryOf("b", "c")],
      [],
    );
    expect((await merged.descriptors()).map((d) => d.name).sort()).toEqual(["a", "b", "c"]);
  });
});
