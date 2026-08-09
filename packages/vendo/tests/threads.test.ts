/**
 * `ThreadRepository`, directly.
 *
 * It arrived here from the deleted `@vendoai/agent`, whose own suite drove it
 * through `createAgent().threads.*` and so died with the door. These are the
 * four properties that suite was the only holder of, asserted against the class
 * itself now that it has a home of its own — every one of them is a rule a
 * caller cannot see and would not notice breaking:
 *
 *   - the listing follows the store's cursor to exhaustion,
 *   - one subject never reads or deletes another's thread,
 *   - a foreign thread id is a conflict, never a takeover,
 *   - one malformed row does not brick the whole listing.
 *
 * The turn door's own behaviour (D4/D6, the loadout cleanup) is proven through
 * the composed wire in `harness-threads.test.ts`; this file is the layer under it.
 */
import { AGENT_CONTEXT_MARK, type Json, type RunContext, type StoreAdapter, type ThreadId } from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { ThreadRepository } from "../src/threads.js";

const ada: RunContext = {
  principal: { kind: "user", subject: "ada" },
  venue: "chat",
  presence: "present",
  sessionId: "s_ada",
};
const bob: RunContext = { ...ada, principal: { kind: "user", subject: "bob" }, sessionId: "s_bob" };

const said = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

/**
 * A store that PAGES, which the in-memory double does not: the shipped one hands
 * back at most 100 rows plus a cursor (proven of the store itself by
 * `storeOpsConformance`), and following that cursor is the repository's job.
 * Without a paging double a single un-looped `list()` reads as correct here.
 */
function pagingStore(pageSize: number): StoreAdapter {
  const inner = memoryStoreAdapter();
  return {
    ...inner,
    records: (collection: string) => {
      const door = inner.records(collection);
      return {
        ...door,
        list: async (query) => door.list({ ...query, limit: pageSize }),
      };
    },
  } as StoreAdapter;
}

describe("the listing follows the store's cursor to exhaustion", () => {
  it("returns every one of a subject's threads past the page size, and evicts them all", async () => {
    const store = pagingStore(100);
    const threads = new ThreadRepository(store);
    for (let i = 0; i < 250; i += 1) {
      await threads.persist(
        { id: `thr_${i}` as ThreadId, subject: "ada", messages: [], createdAt: "", updatedAt: "" },
        [said(`m_${i}`, `thread ${i}`)],
      );
    }

    // A single un-looped page would answer 100 — and the subject's most recently
    // active thread is exactly the one that would vanish.
    expect(await threads.list(ada)).toHaveLength(250);
    expect(await threads.evictSubject("ada")).toHaveLength(250);
    expect(await threads.list(ada)).toEqual([]);
  });
});

describe("one subject never reads or deletes another's thread", () => {
  const seedAdas = async (store: StoreAdapter): Promise<ThreadRepository> => {
    const threads = new ThreadRepository(store);
    await threads.persist(
      { id: "thr_ada" as ThreadId, subject: "ada", messages: [], createdAt: "", updatedAt: "" },
      [said("m1", "Ada's private thread")],
    );
    return threads;
  };

  it("hides it from get and from list", async () => {
    const threads = await seedAdas(memoryStoreAdapter());
    expect(await threads.get("thr_ada" as ThreadId, ada)).not.toBeNull();
    expect(await threads.get("thr_ada" as ThreadId, bob)).toBeNull();
    expect(await threads.list(bob)).toEqual([]);
  });

  it("refuses the delete, and leaves the row where it was", async () => {
    const threads = await seedAdas(memoryStoreAdapter());
    await threads.delete("thr_ada" as ThreadId, bob);
    // Silent to Bob — he learns nothing about a thread he cannot see — and
    // untouched for Ada, which is the half that matters.
    expect(await threads.get("thr_ada" as ThreadId, ada)).not.toBeNull();
  });
});

describe("a foreign thread id is a conflict, never a takeover", () => {
  it("refuses to resolve someone else's id", async () => {
    const store = memoryStoreAdapter();
    const threads = new ThreadRepository(store);
    await threads.persist(
      { id: "thr_shared" as ThreadId, subject: "ada", messages: [], createdAt: "", updatedAt: "" },
      [said("m1", "mine")],
    );
    await expect(threads.resolve("thr_shared" as ThreadId, bob)).rejects.toThrow(/already in use/);
  });

  it("refuses to persist over someone else's row, even holding the id", async () => {
    const store = memoryStoreAdapter();
    const threads = new ThreadRepository(store);
    await threads.persist(
      { id: "thr_shared" as ThreadId, subject: "ada", messages: [], createdAt: "", updatedAt: "" },
      [said("m1", "mine")],
    );
    await expect(threads.persist(
      { id: "thr_shared" as ThreadId, subject: "bob", messages: [], createdAt: "", updatedAt: "" },
      [said("m2", "actually mine")],
    )).rejects.toThrow(/already in use/);
    // Ada's history is intact, not merged with Bob's turn.
    const kept = await threads.get("thr_shared" as ThreadId, ada);
    expect(kept?.messages.map((message) => message.id)).toEqual(["m1"]);
  });
});

describe("a hidden agent-context message is never a thread's name", () => {
  /** uiaudit 2026-08-06 — the chrome answers a connect card by SENDING a marked
   *  text part ("[vendo:context] Declined to connect Gmail."): the model reads it,
   *  a person never sees it, and it arrives as a bare `{ type, text }` with no
   *  metadata at all. `deriveTitle` took the first user text part it found with no
   *  filter, so a thread that opened on one was listed in the rail under the
   *  plumbing (observed live). The mark lives in 01-core now, for exactly this.
   *  The whole chain is proven in `request-connection.seam.test.ts`; this is the
   *  layer under it. */
  it("skips the mark, then takes the first thing the person actually typed", async () => {
    const threads = new ThreadRepository(memoryStoreAdapter());
    const id = "thr_hidden" as ThreadId;

    await threads.persist(
      { id, subject: "ada", messages: [], createdAt: "", updatedAt: "" },
      [said("m1", `${AGENT_CONTEXT_MARK} Declined to connect Gmail.`)],
    );
    // Nothing eligible yet, so the existing fallback stands — never the mark.
    expect(await threads.list(ada)).toMatchObject([{ id, title: "New thread" }]);

    await threads.persist(
      { id, subject: "ada", messages: [], createdAt: "", updatedAt: "" },
      [said("m1", `${AGENT_CONTEXT_MARK} Declined to connect Gmail.`), said("m2", "Summarise this week's spending")],
    );
    const listed = await threads.list(ada);
    expect(listed).toMatchObject([{ id, title: "Summarise this week's spending" }]);
    expect(JSON.stringify(listed)).not.toContain(AGENT_CONTEXT_MARK);
  });
});

describe("a junk row does not brick the listing", () => {
  it("tolerates messages nothing can be titled from, and still lists the good thread", async () => {
    const store = memoryStoreAdapter();
    const threads = new ThreadRepository(store);
    await threads.persist(
      { id: "thr_good" as ThreadId, subject: "ada", messages: [], createdAt: "", updatedAt: "" },
      [said("m1", "a real conversation")],
    );
    // Written straight through the store seam, which accepts any Json inside a
    // well-formed envelope: a null, a message with no `parts`, and something that
    // is not a message at all. All three are shapes a hand-written or
    // partially-migrated row really has, and none may cost the subject every
    // OTHER thread they own — the title derivation has to skip them, not throw.
    await store.records("vendo_threads").put({
      id: "thr_junk",
      data: { subject: "ada", messages: [null, { role: "user" }, "not-a-message"] } as unknown as Json,
      refs: { subject: "ada" },
    });

    const listed = await threads.list(ada);
    expect(listed.map((summary) => summary.id).sort()).toEqual(["thr_good", "thr_junk"]);
    expect(listed.find((summary) => summary.id === "thr_good")?.title).toBe("a real conversation");
    expect(listed.find((summary) => summary.id === "thr_junk")?.title).toBe("New thread");
  });
});
