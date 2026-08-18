import { describe, expect, it } from "vitest";
import { z as z3 } from "zod/v3";
import { z } from "zod/v4";
import { defineTool } from "../src/define-tool.js";
import type { RunContext, ToolCall } from "../src/index.js";

const ctx = {} as RunContext;
const call = {} as ToolCall;

describe("defineTool", () => {
  it("publishes the zod schema as the descriptor's inputSchema, with no $schema rider", () => {
    const tool = defineTool({
      name: "host_task_delete",
      description: "Delete a task",
      input: z.object({ id: z.string() }),
      risk: "destructive",
      execute: async () => ({ deleted: true }),
    });

    expect(tool).toMatchObject({
      name: "host_task_delete",
      description: "Delete a task",
      risk: "destructive",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    });
    expect(tool.inputSchema).not.toHaveProperty("$schema");
  });

  it("parses the arguments before executing, and a mismatch never reaches execute", async () => {
    let ran = false;
    const tool = defineTool({
      name: "host_task_delete",
      description: "Delete a task",
      input: z.object({ id: z.string() }),
      risk: "destructive",
      execute: async ({ id }) => {
        ran = true;
        return { deleted: id };
      },
    });

    expect(await tool.execute({ id: "t_1" }, ctx, call)).toEqual({ deleted: "t_1" });
    ran = false;
    await expect(tool.execute({ id: 7 }, ctx, call)).rejects.toThrow(/host_task_delete.*id/s);
    expect(ran).toBe(false);
  });

  it("parses a schema whose refinement is async, instead of throwing out of the parse", async () => {
    const tool = defineTool({
      name: "host_task_claim",
      description: "Claim a task",
      input: z.object({ id: z.string().refine(async (id) => id.startsWith("t_"), "unknown task") }),
      risk: "write",
      execute: async ({ id }) => ({ claimed: id }),
    });

    expect(await tool.execute({ id: "t_1" }, ctx, call)).toEqual({ claimed: "t_1" });
    await expect(tool.execute({ id: "nope" }, ctx, call)).rejects.toThrow(/host_task_claim.*unknown task/s);
  });

  it("stays a plain ToolDefinition, so a spread still reaches the fields it does not ask for", () => {
    const tool = { ...defineTool({
      name: "host_task_delete",
      description: "Delete a task",
      input: z.object({ id: z.string() }),
      risk: "destructive",
      execute: async () => null,
    }), confirmEach: true, title: "Delete a task" };

    expect(tool).toMatchObject({ risk: "destructive", confirmEach: true, title: "Delete a task" });
  });

  it("names the fix when it is handed a zod 3 schema", () => {
    const attempt = (): unknown => defineTool({
      name: "host_task_delete",
      description: "Delete a task",
      // The whole point: a zod 3 schema typechecks nowhere near here in a host,
      // it arrives from an untyped call site or a mismatched transitive zod.
      input: z3.object({ id: z3.string() }) as never,
      risk: "destructive",
      execute: async () => null,
    });

    expect(attempt).toThrow(/zod 3 schema.*zod\/v4/s);
  });
});
