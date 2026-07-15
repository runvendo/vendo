import type { StoreAdapter } from "@vendoai/core";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "./index.js";
import {
  boundRegistry,
  ctx,
  memoryStore,
  readSse,
  scriptedModel,
  testGuard,
  textTurn,
  userMessage,
} from "./test-helpers.js";

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

  it("skips a malformed thread row instead of bricking the whole listing (M5)", async () => {
    const canonicalStore = memoryStore();
    // The canonical reserved route now rejects malformed rows on write, like
    // the real store. Redirect this resilience test to a generic collection so
    // it can still model a pre-existing/corrupt database row at the read seam.
    const store: StoreAdapter = {
      ensureSchema: () => canonicalStore.ensureSchema(),
      records: (collection) => canonicalStore.records(
        collection === "vendo_threads" ? "agent_corruptible_threads" : collection,
      ),
      blobs: (namespace) => canonicalStore.blobs(namespace),
    };
    const guard = testGuard({});
    const tools = boundRegistry({}, guard);
    const agent = createAgent({
      model: scriptedModel([textTurn("Good reply.", "text_good")]),
      tools,
      guard,
      store,
    });
    const runCtx = ctx();

    // A well-formed thread for the subject.
    await readSse(await agent.stream({
      threadId: "thr_good",
      message: userMessage("user_good", "Good question"),
      ctx: runCtx,
    }));

    // Junk-MESSAGES row for the SAME subject, written straight through the store
    // seam: a message with no `parts` and a non-object message. This is a valid
    // Thread whose messages yield no title — titleFor must TOLERATE it (fall back
    // to "New thread") rather than throwing and bricking the whole listing.
    await store.records("vendo_threads").put({
      id: "thr_junk_msgs",
      data: { subject: "u1", messages: [{ role: "user" }, "not-a-message"] },
      refs: { subject: "u1" },
    });
    // Truly-unparseable row (messages is not even an array): threadFromRecord must
    // SKIP it (return null) so it never reaches titleFor.
    await store.records("vendo_threads").put({
      id: "thr_unparseable",
      data: { subject: "u1", messages: "nope" },
      refs: { subject: "u1" },
    });

    // No throw; the good thread keeps its title, the junk-messages thread lists
    // with the fallback title, the unparseable row is dropped.
    const summaries = await agent.threads.list(runCtx);
    expect(summaries.map((s) => s.id).sort()).toEqual(["thr_good", "thr_junk_msgs"]);
    expect(summaries.find((s) => s.id === "thr_good")).toMatchObject({ title: "Good question" });
    expect(summaries.find((s) => s.id === "thr_junk_msgs")).toMatchObject({ title: "New thread" });
  });

  describe("persist failure after a completed stream (ENG-309 / AGENT-8)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** A store whose vendo_threads WRITES fail the first `failures` times (all
     *  other collections and operations pass through untouched). */
    function failingThreadWrites(inner: StoreAdapter, failures: number): {
      store: StoreAdapter;
      writeAttempts: () => number;
    } {
      let attempts = 0;
      const failNext = (): void => {
        attempts += 1;
        if (attempts <= failures) throw new Error("injected store write failure");
      };
      const store: StoreAdapter = {
        ensureSchema: () => inner.ensureSchema(),
        blobs: (namespace) => inner.blobs(namespace),
        records: (collection) => {
          const records = inner.records(collection);
          if (collection !== "vendo_threads") return records;
          return {
            ...records,
            async put(record) {
              failNext();
              return records.put(record);
            },
            ...(records.atomic === undefined ? {} : {
              atomic: {
                async insertIfAbsent(record) {
                  failNext();
                  return records.atomic!.insertIfAbsent(record);
                },
                async compareAndSwap(record, expectedRevision) {
                  failNext();
                  return records.atomic!.compareAndSwap(record, expectedRevision);
                },
              },
            }),
          };
        },
      };
      return { store, writeAttempts: () => attempts };
    }

    it("retries a transient store write failure so the completed turn is not silently lost", async () => {
      const { store, writeAttempts } = failingThreadWrites(memoryStore(), 2);
      const guard = testGuard({});
      const agent = createAgent({
        model: scriptedModel([textTurn("Saved reply.", "text_retry")]),
        tools: boundRegistry({}, guard),
        guard,
        store,
      });
      const runCtx = ctx();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await agent.stream({
        threadId: "thr_retry",
        message: userMessage("user_retry", "Please save this"),
        ctx: runCtx,
      });
      const { rawFrames } = await readSse(response);

      // The user saw a complete, successful stream…
      expect(rawFrames.at(-1)).toBe("data: [DONE]\n\n");
      // …and the thread survived the transient write failures.
      await vi.waitFor(async () => {
        const thread = await agent.threads.get("thr_retry", runCtx);
        expect(thread).not.toBeNull();
        expect(thread!.messages.some((message) => message.id === "user_retry")).toBe(true);
        expect(assistantText(thread!.messages)).toContain("Saved reply.");
      });
      expect(writeAttempts()).toBeGreaterThan(2);
      // A recovered persist is not a loud failure.
      expect(errorSpy.mock.calls.filter(([first]) => String(first).includes("thread persist failed"))).toEqual([]);
    });

    it("surfaces a permanent store write failure loudly instead of swallowing it", async () => {
      const { store } = failingThreadWrites(memoryStore(), Number.POSITIVE_INFINITY);
      const guard = testGuard({});
      const agent = createAgent({
        model: scriptedModel([textTurn("Doomed reply.", "text_doomed")]),
        tools: boundRegistry({}, guard),
        guard,
        store,
      });
      const runCtx = ctx();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await agent.stream({
        threadId: "thr_doomed",
        message: userMessage("user_doomed", "This write always fails"),
        ctx: runCtx,
      });
      // The stream still completes cleanly for the user — persist failure after
      // [DONE] must never corrupt or error the already-delivered response.
      const { rawFrames } = await readSse(response);
      expect(rawFrames.at(-1)).toBe("data: [DONE]\n\n");

      // The failure is surfaced as a loud, structured error naming the thread.
      await vi.waitFor(() => {
        const call = errorSpy.mock.calls.find(([first]) => String(first).includes("thread persist failed"));
        expect(call).toBeDefined();
        expect(call![0]).toContain("[vendo]");
        expect(call![1]).toMatchObject({
          threadId: "thr_doomed",
          subject: "u1",
          error: "injected store write failure",
        });
      });
    });
  });

  describe("concurrent turns on one thread (ENG-310 / AGENT-9)", () => {
    it("two overlapping stream() calls on one threadId keep BOTH turns' messages", async () => {
      const store = memoryStore();
      const guard = testGuard({});
      const agent = createAgent({
        model: scriptedModel([
          textTurn("Reply one.", "text_race_1"),
          textTurn("Reply two.", "text_race_2"),
        ]),
        tools: boundRegistry({}, guard),
        guard,
        store,
      });
      const runCtx = ctx();
      const threadId = "thr_race";

      // Two tabs on one thread: both turns resolve the thread BEFORE either
      // persists, so each holds its own copy — the last-write-wins put used to
      // clobber whichever turn finished first.
      const [first, second] = await Promise.all([
        agent.stream({ threadId, message: userMessage("user_race_1", "Question one"), ctx: runCtx }),
        agent.stream({ threadId, message: userMessage("user_race_2", "Question two"), ctx: runCtx }),
      ]);
      await Promise.all([readSse(first), readSse(second)]);

      // waitFor: robust against a store whose writes settle after stream close.
      const thread = await vi.waitFor(async () => {
        const persisted = await agent.threads.get(threadId, runCtx);
        expect(persisted).not.toBeNull();
        expect(persisted!.messages.some((message) => message.id === "user_race_1")).toBe(true);
        expect(persisted!.messages.some((message) => message.id === "user_race_2")).toBe(true);
        return persisted!;
      });
      const replies = assistantText(thread.messages);
      expect(replies).toContain("Reply one.");
      expect(replies).toContain("Reply two.");
      // One thread row, not a fork.
      const rows = await store.records("vendo_threads").list({ refs: { subject: "u1" } });
      expect(rows.records).toHaveLength(1);
    });

    it("overlapping turns on an EXISTING thread preserve prior history and both new turns", async () => {
      const store = memoryStore();
      const guard = testGuard({});
      const agent = createAgent({
        model: scriptedModel([
          textTurn("Seed reply.", "text_seed"),
          textTurn("Branch A.", "text_branch_a"),
          textTurn("Branch B.", "text_branch_b"),
        ]),
        tools: boundRegistry({}, guard),
        guard,
        store,
      });
      const runCtx = ctx();
      const threadId = "thr_race_existing";

      await readSse(await agent.stream({
        threadId,
        message: userMessage("user_seed", "Seed question"),
        ctx: runCtx,
      }));

      const [first, second] = await Promise.all([
        agent.stream({ threadId, message: userMessage("user_branch_a", "Branch question A"), ctx: runCtx }),
        agent.stream({ threadId, message: userMessage("user_branch_b", "Branch question B"), ctx: runCtx }),
      ]);
      await Promise.all([readSse(first), readSse(second)]);

      // waitFor: robust against a store whose writes settle after stream close.
      const thread = await vi.waitFor(async () => {
        const persisted = await agent.threads.get(threadId, runCtx);
        expect(persisted).not.toBeNull();
        for (const id of ["user_seed", "user_branch_a", "user_branch_b"]) {
          expect(persisted!.messages.some((message) => message.id === id)).toBe(true);
        }
        return persisted!;
      });
      const replies = assistantText(thread.messages);
      expect(replies).toContain("Seed reply.");
      expect(replies).toContain("Branch A.");
      expect(replies).toContain("Branch B.");
    });
  });

  it("lets two subjects privately use the same thread id in MEMORY mode (no store)", async () => {
    // With no store, threads live in per-subject maps: the same id is two distinct
    // private threads — no conflict, no leak. This pins the intentional divergence
    // from the store path (where the bare-id row forces cross-subject refusal).
    const guard = testGuard({});
    const tools = boundRegistry({}, guard);
    const agent = createAgent({
      model: scriptedModel([
        textTurn("Alice reply.", "text_alice"),
        textTurn("Bob reply.", "text_bob"),
      ]),
      tools,
      guard,
      // no store
    });
    const alice = ctx({ principal: { kind: "user", subject: "alice" }, sessionId: "sa" });
    const bob = ctx({ principal: { kind: "user", subject: "bob" }, sessionId: "sb" });
    const sharedId = "thr_shared_id";

    await readSse(await agent.stream({ threadId: sharedId, message: userMessage("m_a", "Hi from Alice"), ctx: alice }));
    // Bob reusing the SAME id does NOT conflict and does NOT see Alice's thread.
    await readSse(await agent.stream({ threadId: sharedId, message: userMessage("m_b", "Hi from Bob"), ctx: bob }));

    const aliceThread = await agent.threads.get(sharedId, alice);
    const bobThread = await agent.threads.get(sharedId, bob);
    expect(assistantText(aliceThread!.messages)).toContain("Alice reply.");
    expect(assistantText(aliceThread!.messages)).not.toContain("Bob reply.");
    expect(assistantText(bobThread!.messages)).toContain("Bob reply.");
    expect(assistantText(bobThread!.messages)).not.toContain("Alice reply.");
    expect(aliceThread!.messages.some((m) => m.id === "m_b")).toBe(false);
    expect(bobThread!.messages.some((m) => m.id === "m_a")).toBe(false);
  });
});
