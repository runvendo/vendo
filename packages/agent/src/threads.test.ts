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

  it("isolates get, list, and delete by principal subject — one subject never reads or deletes another's thread", async () => {
    const store = memoryStore();
    const guard = testGuard({});
    const tools = boundRegistry({}, guard);
    const agent = createAgent({
      model: scriptedModel([
        textTurn("Private reply.", "text_private"),
        textTurn("Independent reply.", "text_independent"),
      ]),
      tools,
      guard,
      store,
    });
    const u1 = ctx();
    const u2 = ctx({
      principal: { kind: "user", subject: "u2" },
      sessionId: "s2",
    });
    // Reserved vendo_threads rows are keyed by the bare thread id (02 §2 — `id`
    // is the primary key), so each thread is one row; subjects own distinct
    // ids. Isolation (03 §5) is enforced by subject checks on read/delete.
    const u1ThreadId = "thr_private_u1";
    const u2ThreadId = "thr_private_u2";

    await readSse(await agent.stream({
      threadId: u1ThreadId,
      message: userMessage("user_private", "Private question"),
      ctx: u1,
    }));

    // u2 cannot see u1's thread by id or in its own listing.
    expect(await agent.threads.get(u1ThreadId, u2)).toBeNull();
    expect(await agent.threads.list(u2)).toEqual([]);

    const u1Before = await agent.threads.get(u1ThreadId, u1);
    await readSse(await agent.stream({
      threadId: u2ThreadId,
      message: userMessage("user_independent", "Independent question"),
      ctx: u2,
    }));

    // u2's own thread is independent; u1's is untouched and still private to u1.
    const u2Thread = await agent.threads.get(u2ThreadId, u2);
    expect(u2Thread).toMatchObject({ id: u2ThreadId, subject: "u2" });
    expect(assistantText(u2Thread!.messages)).toContain("Independent reply.");
    expect(await agent.threads.get(u2ThreadId, u1)).toBeNull();
    expect(await agent.threads.get(u1ThreadId, u1)).toEqual(u1Before);
    expect(await agent.threads.list(u1)).toHaveLength(1);
    expect(await agent.threads.list(u2)).toHaveLength(1);

    // A foreign-subject delete is a no-op: u2 cannot delete u1's thread.
    await agent.threads.delete(u1ThreadId, u2);
    expect(await agent.threads.get(u1ThreadId, u1)).not.toBeNull();
    expect(await agent.threads.list(u1)).toHaveLength(1);
  });

  it("refuses to reuse another subject's persisted thread id (conflict, no takeover)", async () => {
    const store = memoryStore();
    const guard = testGuard({});
    const tools = boundRegistry({}, guard);
    const agent = createAgent({
      model: scriptedModel([textTurn("Owned reply.", "text_owned")]),
      tools,
      guard,
      store,
    });
    const u1 = ctx();
    const u2 = ctx({
      principal: { kind: "user", subject: "u2" },
      sessionId: "s2",
    });
    const threadId = "thr_owned_by_u1";

    await readSse(await agent.stream({
      threadId,
      message: userMessage("user_owned", "Mine"),
      ctx: u1,
    }));

    // u2 streaming to u1's id must be refused outright: get() reads the
    // foreign row as null, but silently reusing the id would let persist()'s
    // bare-id upsert take over u1's row (03 §5).
    await expect(agent.stream({
      threadId,
      message: userMessage("user_takeover", "Take over"),
      ctx: u2,
    })).rejects.toMatchObject({ code: "conflict" });

    // u1's thread is intact — same subject, same messages — and u2 owns nothing.
    const intact = await agent.threads.get(threadId, u1);
    expect(intact).toMatchObject({ id: threadId, subject: "u1" });
    expect(intact!.messages.some((message) => message.id === "user_owned")).toBe(true);
    expect(intact!.messages.some((message) => message.id === "user_takeover")).toBe(false);
    expect(await agent.threads.list(u2)).toEqual([]);
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
