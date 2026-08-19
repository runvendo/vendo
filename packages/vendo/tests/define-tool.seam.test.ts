import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, RunContext } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { defineTool } from "../src/index.js";
import { createVendo, type Vendo } from "../src/server.js";

// The seam `defineTool` exists for, with nothing stubbed on either side: a
// hand-written tool goes into the REAL `tools:` slot, comes back out of the
// REAL guard-bound registry, and answers the real outcomes — the approval the
// policy asks for, and the refusal its own zod schema earns.

const principal: Principal = { kind: "user", subject: "user_define_tool" };
const ctx: RunContext = {
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "session_define_tool",
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-define-tool-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

async function setup(): Promise<{ vendo: Vendo; ran: string[] }> {
  const ran: string[] = [];
  const store = await tempStore();
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store,
    tools: [
      defineTool({
        name: "host_task_read",
        description: "Read a task",
        input: z.object({ id: z.string() }),
        risk: "read",
        execute: async ({ id }) => {
          ran.push(`read:${id}`);
          return { id, title: "Ship the slice" };
        },
      }),
      defineTool({
        name: "host_task_delete",
        description: "Permanently delete a task",
        input: z.object({ id: z.string() }),
        risk: "destructive",
        execute: async ({ id }) => {
          ran.push(`delete:${id}`);
          return { deleted: id };
        },
      }),
    ],
    guard: { policy: { rules: [{ match: { risk: "destructive" }, action: "ask" }] } },
  });
  await store.ensureSchema();
  return { vendo, ran };
}

describe.sequential("defineTool through the real tools: slot and the real guard", () => {
  it("projects the zod schema onto the descriptor the model is shown", async () => {
    const { vendo } = await setup();

    const descriptor = (await vendo.guardedTools.descriptors(ctx))
      .find(({ name }) => name === "host_task_delete");

    expect(descriptor).toMatchObject({
      risk: "destructive",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    });
  });

  it("runs, and parks an approval for the risk the policy asks about", async () => {
    const { vendo, ran } = await setup();

    const read = await vendo.guardedTools.execute(
      { id: "call_read", tool: "host_task_read", args: { id: "t_1" } },
      ctx,
    );
    expect(read).toEqual({ status: "ok", output: { id: "t_1", title: "Ship the slice" } });

    const parked = await vendo.guardedTools.execute(
      { id: "call_delete", tool: "host_task_delete", args: { id: "t_1" } },
      ctx,
    );
    expect(parked.status).toBe("pending-approval");
    // The guard is holding it: the tool body never ran.
    expect(ran).toEqual(["read:t_1"]);
  });

  it("refuses arguments its own schema rejects, before execute runs", async () => {
    const { vendo, ran } = await setup();

    const outcome = await vendo.guardedTools.execute(
      { id: "call_bad", tool: "host_task_read", args: { id: 7 } },
      ctx,
    );

    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
    expect(ran).toEqual([]);
  });
});
