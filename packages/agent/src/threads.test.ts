import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import {
  boundRegistry,
  ctx,
  memoryStore,
  readSse,
  scriptedModel,
  testGuard,
  textTurn,
} from "./test-helpers.js";

const userMessage = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

function assistantText(messages: UIMessage[]): string {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

describe("agent threads", () => {
  it("persists complete turns, derives an 80-character title, and appends on the same thread", async () => {
    const store = memoryStore();
    const guard = testGuard({});
    const tools = boundRegistry({}, guard);
    const model = scriptedModel([
      textTurn("First reply.", "text_thread_1"),
      textTurn("Second reply.", "text_thread_2"),
    ]);
    const agent = createAgent({ model, tools, guard, store });
    const runCtx = ctx();
    const threadId = "thr_persisted";
    const firstText = "A".repeat(90);

    const firstResponse = await agent.stream({
      threadId,
      message: userMessage("user_thread_1", firstText),
      ctx: runCtx,
    });
    await readSse(firstResponse);

    const summaries = await agent.threads.list(runCtx);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: threadId, title: "A".repeat(80) });
    expect(summaries[0]!.title).toHaveLength(80);
    const firstThread = await agent.threads.get(threadId, runCtx);
    expect(firstThread).not.toBeNull();
    expect(firstThread).toMatchObject({ id: threadId, subject: "u1" });
    expect(firstThread!.messages.some((message) => message.id === "user_thread_1")).toBe(true);
    expect(assistantText(firstThread!.messages)).toContain("First reply.");
    const records = await store.records("vendo_threads").list({ refs: { subject: "u1" } });
    expect(records.records).toHaveLength(1);
    expect(records.records[0]?.refs).toEqual({ subject: "u1" });

    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    const secondResponse = await agent.stream({
      threadId,
      message: userMessage("user_thread_2", "Continue"),
      ctx: runCtx,
    });
    await readSse(secondResponse);

    const secondThread = await agent.threads.get(threadId, runCtx);
    expect(secondThread).not.toBeNull();
    expect(secondThread!.messages.some((message) => message.id === "user_thread_2")).toBe(true);
    expect(assistantText(secondThread!.messages)).toContain("First reply.");
    expect(assistantText(secondThread!.messages)).toContain("Second reply.");
    expect(Date.parse(secondThread!.updatedAt)).toBeGreaterThan(Date.parse(firstThread!.updatedAt));
  });

  it("isolates get, list, and delete by principal subject", async () => {
    const store = memoryStore();
    const guard = testGuard({});
    const tools = boundRegistry({}, guard);
    const agent = createAgent({
      model: scriptedModel([textTurn("Private reply.", "text_private")]),
      tools,
      guard,
      store,
    });
    const u1 = ctx();
    const u2 = ctx({
      principal: { kind: "user", subject: "u2" },
      sessionId: "s2",
    });
    const threadId = "thr_private";

    const response = await agent.stream({
      threadId,
      message: userMessage("user_private", "Private question"),
      ctx: u1,
    });
    await readSse(response);

    expect(await agent.threads.get(threadId, u2)).toBeNull();
    expect(await agent.threads.list(u2)).toEqual([]);
    await agent.threads.delete(threadId, u2);
    expect(await agent.threads.get(threadId, u1)).not.toBeNull();
    expect(await agent.threads.list(u1)).toHaveLength(1);
  });

  it("keeps ephemeral principal threads in session memory even when a store is configured", async () => {
    const store = memoryStore();
    const guard = testGuard({});
    const tools = boundRegistry({}, guard);
    const agent = createAgent({
      model: scriptedModel([textTurn("Ephemeral reply.", "text_ephemeral")]),
      tools,
      guard,
      store,
    });
    const ephemeralCtx = ctx({
      principal: { kind: "user", subject: "guest_1", ephemeral: true },
      sessionId: "guest_session_1",
    });
    const threadId = "thr_ephemeral";

    const response = await agent.stream({
      threadId,
      message: userMessage("user_ephemeral", "Temporary question"),
      ctx: ephemeralCtx,
    });
    await readSse(response);

    const persisted = await store.records("vendo_threads").list();
    expect(persisted.records).toEqual([]);
    const thread = await agent.threads.get(threadId, ephemeralCtx);
    expect(thread).not.toBeNull();
    expect(thread).toMatchObject({ id: threadId, subject: "guest_1" });
    expect(assistantText(thread!.messages)).toContain("Ephemeral reply.");
    expect(await agent.threads.list(ephemeralCtx)).toEqual([
      expect.objectContaining({ id: threadId, title: "Temporary question" }),
    ]);
  });
});
