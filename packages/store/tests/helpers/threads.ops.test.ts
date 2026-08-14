/**
 * Conversations (02-store §3), proven against every backend they can sit on —
 * the harness-state and transcript suites' sibling, same shape and same reason.
 *
 * `threadStore` demanded a SQL handle, which is why a key-only deployment could
 * not hold a conversation at all: every session and every away-run opens one. It
 * picks a backend now (`backendOf`), so this file is the proof that §3's rules —
 * a thread reads back as it was written, threads NEVER cross subjects, a delete
 * cascades, and an answer is never overwritten — read identically whichever
 * backend answers.
 */
import { VendoError, type Principal, type StoreOps } from "@vendoai/core";
import { memoryStoreOps } from "@vendoai/core/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../../src/backends.test-util.js";
import { createStoreOps, threadStore, type VendoStore } from "../../src/index.js";

const alice: Principal = { kind: "user", subject: "user_alice" };
const bob: Principal = { kind: "user", subject: "user_bob" };

/** Not a handle `@vendoai/store` minted — the shape a hosted store presents. */
function opsOnlyStore(ops: StoreOps): VendoStore {
  const unused = (what: string): never => {
    throw new Error(`the thread helper must not reach ${what}`);
  };
  return {
    ops,
    records: () => unused("records()"),
    blobs: () => unused("blobs()"),
    async ensureSchema() {},
    async close() {},
    raw: () => unused("raw()"),
  };
}

/** Ids are namespaced per mode because `local-ops` and `sql` share one database. */
const modesFor = (made: MadeBackend): Array<{ name: string; store: VendoStore }> => [
  { name: "sql", store: made.store },
  { name: "memory-ops", store: opsOnlyStore(memoryStoreOps()) },
  { name: "local-ops", store: opsOnlyStore(createStoreOps(made.store)) },
];

for (const backend of backends()) {
  describe(`${backend.name} conversations across backends (02-store §3)`, () => {
    let made: MadeBackend;
    let modes: Array<{ name: string; store: VendoStore }>;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
      modes = modesFor(made);
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    describe.each([{ mode: "sql" }, { mode: "memory-ops" }, { mode: "local-ops" }])("$mode", ({ mode }) => {
      const pick = (): VendoStore => modes.find((candidate) => candidate.name === mode)!.store;
      const id = (suffix: string): string => `thr_${mode.replace("-", "_")}_${suffix}`;

      it("a thread reads back as it was written", async () => {
        const threads = threadStore(pick());
        const thread = id("round_trip");
        await threads.put(alice, { id: thread, messages: [{ id: "m1", role: "user" }] });

        const row = await threads.get(alice, thread);
        expect(row?.subject).toBe(alice.subject);
        expect(row?.messages).toEqual([{ id: "m1", role: "user" }]);
      });

      it("threads never cross subjects: a foreign thread reads as absent", async () => {
        const threads = threadStore(pick());
        const thread = id("foreign");
        await threads.put(alice, { id: thread, messages: [] });

        expect(await threads.get(bob, thread)).toBeNull();
      });

      it("list is scoped to the asking subject", async () => {
        const threads = threadStore(pick());
        await threads.put(alice, { id: id("mine"), messages: [] });
        await threads.put(bob, { id: id("theirs"), messages: [] });

        const ids = (await threads.list(alice)).map((entry) => entry.id);
        expect(ids).toContain(id("mine"));
        expect(ids).not.toContain(id("theirs"));
      });

      it("delete removes the thread, and a foreign delete sweeps nothing", async () => {
        const threads = threadStore(pick());
        const thread = id("gone");
        await threads.put(alice, { id: thread, messages: [] });

        await threads.delete(bob, thread);
        expect(await threads.get(alice, thread)).not.toBeNull();
        await threads.delete(alice, thread);
        expect(await threads.get(alice, thread)).toBeNull();
      });

      it("an answer lands in its own thread, and a reused questionId is refused", async () => {
        const threads = threadStore(pick());
        const thread = id("answered");
        await threads.put(alice, { id: thread, messages: [] });
        await threads.recordAnswer(alice, { threadId: thread, questionId: "q_1", answer: { text: "yes" } });

        expect((await threads.get(alice, thread))?.messages).toHaveLength(1);
        // Two answers are never the same answer, so the second is refused rather
        // than overwriting the first (or reporting a success that never happened).
        await expect(
          threads.recordAnswer(alice, { threadId: thread, questionId: "q_1", answer: { text: "no" } }),
        ).rejects.toBeInstanceOf(VendoError);
      });

      it("an answer cannot be written into someone else's thread", async () => {
        const threads = threadStore(pick());
        const thread = id("not_yours");
        await threads.put(alice, { id: thread, messages: [] });

        await expect(
          threads.recordAnswer(bob, { threadId: thread, questionId: "q_2", answer: { text: "hi" } }),
        ).rejects.toThrow(/does not belong to this subject/);
      });
    });
  });
}

/** The real memory ops, one thread per page: `threadStore.list` sends no limit,
 *  so this is how a subject with more threads than fit in one service page is
 *  reached without writing the default page size (100) of them. */
function pagedOneAtATime(ops: StoreOps, onList?: () => void): StoreOps {
  return {
    ...ops,
    transcripts: {
      ...ops.transcripts,
      async listThreads(query) {
        onList?.();
        return await ops.transcripts.listThreads({ ...query, limit: 1 });
      },
    },
  };
}

describe("a hosted list whose service pages", () => {
  it("returns every thread, not just the first page", async () => {
    const threads = threadStore(opsOnlyStore(pagedOneAtATime(memoryStoreOps())));
    for (const suffix of ["p1", "p2", "p3"]) {
      await threads.put(alice, { id: `thr_paged_${suffix}`, messages: [] });
    }
    await threads.put(bob, { id: "thr_paged_theirs", messages: [] });

    const ids = (await threads.list(alice)).map((entry) => entry.id).sort();
    expect(ids).toEqual(["thr_paged_p1", "thr_paged_p2", "thr_paged_p3"]);
  });

  it("ends the walk when the service repeats a cursor, rather than paging forever", async () => {
    let calls = 0;
    const ops = memoryStoreOps();
    const paged = pagedOneAtATime(ops, () => { calls += 1; });
    const stuck: StoreOps = {
      ...paged,
      transcripts: {
        ...paged.transcripts,
        async listThreads(query) {
          return { ...(await paged.transcripts.listThreads(query)), cursor: "stuck" };
        },
      },
    };
    const threads = threadStore(opsOnlyStore(stuck));
    await threads.put(alice, { id: "thr_stuck_1", messages: [] });
    await threads.put(alice, { id: "thr_stuck_2", messages: [] });

    await threads.list(alice);
    expect(calls).toBe(2);
  });
});

describe("a store with neither a SQL handle nor a StoreOps surface", () => {
  it("is refused by name, at construction", () => {
    const bare = { ...opsOnlyStore(memoryStoreOps()), ops: undefined };
    expect(() => threadStore(bare)).toThrow(/SQL handle or a StoreOps-capable store/);
  });
});
