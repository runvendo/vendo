/**
 * The transcript helper, proven against EVERY backend it can sit on.
 *
 * `threadMessageStore` used to open with `dbFor(store)`, so a store with no SQL
 * handle — every hosted deployment — got "Unknown VendoStore handle" and the
 * host silently fell back to the legacy chat path. It picks a backend now
 * (`backendOf`), and the point of this file is that the CHOICE is invisible: one
 * suite, three backends, same answers.
 *
 * The three:
 *  - `sql`         — the store's own Postgres, the shipped path;
 *  - `memory-ops`  — `memoryStoreOps()`, core's reference StoreOps;
 *  - `local-ops`   — `createStoreOps(store)`, the 31-op contract served off the
 *                    same real database, which is the closest offline stand-in
 *                    for the console's own implementation.
 *
 * The console itself is proven with no stand-in at all, against Yousef's Vendo
 * Cloud account, in `packages/vendo/src/hosted-transcript.live.test.ts`.
 */
import { VendoError, type Principal, type StoreOps } from "@vendoai/core";
import { memoryStoreOps } from "@vendoai/core/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
// The store deliberately does not depend on `ai` (src/helpers/thread-messages.ts),
// so its own generic stand-in plays the runtime's `UIMessage` here.
import {
  createStoreOps,
  threadMessageStore,
  threadStore,
  type ThreadMessageLike as UIMessage,
  type VendoStore,
} from "../src/index.js";

const alice: Principal = { kind: "user", subject: "user_alice" };
const bob: Principal = { kind: "user", subject: "user_bob" };

function message(id: string, text: string, role: "user" | "assistant" = "user"): UIMessage {
  return { id, role, parts: [{ type: "text", text }] } as UIMessage;
}

/**
 * A store the way a HOST supplies one: the public `VendoStore` surface plus a
 * StoreOps, but NOT a handle `@vendoai/store` minted — so it is absent from the
 * package's internals WeakMap and `dbFor` misses it. That is exactly the shape
 * the Cloud hosted store presents.
 */
function opsOnlyStore(ops: StoreOps): VendoStore {
  const unused = (what: string): never => {
    throw new Error(`the transcript helper must not reach ${what}`);
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

interface Mode {
  name: string;
  store: VendoStore;
  own(id: string, subject: string): Promise<void>;
}

/** Ids are namespaced per mode because `local-ops` and `sql` share one database. */
const modesFor = (made: MadeBackend): Mode[] => {
  const viaOps = (name: string, ops: StoreOps): Mode => ({
    name,
    store: opsOnlyStore(ops),
    own: async (id, subject) => { await ops.transcripts.putThread({ id, subject, messages: [] }); },
  });
  return [
    {
      name: "sql",
      store: made.store,
      own: async (id, subject) => { await threadStore(made.store).put({ kind: "user", subject }, { id, messages: [] }); },
    },
    viaOps("memory-ops", memoryStoreOps()),
    viaOps("local-ops", createStoreOps(made.store)),
  ];
};

for (const backend of backends()) {
  describe(`${backend.name} transcript helper across backends (build contract §6, design D1/D2)`, () => {
    let made: MadeBackend;
    let modes: Mode[];
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
      modes = modesFor(made);
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    describe.each([{ mode: "sql" }, { mode: "memory-ops" }, { mode: "local-ops" }])("$mode", ({ mode }) => {
      const pick = (): Mode => modes.find((candidate) => candidate.name === mode)!;
      const id = (suffix: string): string => `thr_${mode.replace("-", "_")}_${suffix}`;

      it("reads back every message it wrote, oldest → newest", async () => {
        const { store, own } = pick();
        const thread = id("order");
        await own(thread, alice.subject);
        const messages = threadMessageStore<UIMessage>(store);
        await messages.upsert(alice, thread, message("m_a", "first"), 0);
        await messages.upsert(alice, thread, message("m_b", "second"), 1);
        await messages.upsert(alice, thread, message("m_c", "third"), 2);

        // A FRESH helper: nothing is cached in the handle, the rows are the truth.
        const listed = await threadMessageStore<UIMessage>(store).list(alice, thread);
        expect(listed.map((m) => m.id)).toEqual(["m_a", "m_b", "m_c"]);
      });

      it("scopes to the principal: one subject never reads another's thread messages", async () => {
        const { store, own } = pick();
        const thread = id("scoped");
        await own(thread, alice.subject);
        const messages = threadMessageStore<UIMessage>(store);
        await messages.upsert(alice, thread, message("m_secret", "alice only"), 0);

        await expect(messages.list(bob, thread)).resolves.toEqual([]);
      });

      it("a thread nobody created reads as empty rather than throwing", async () => {
        const messages = threadMessageStore<UIMessage>(pick().store);
        await expect(messages.list(alice, id("absent"))).resolves.toEqual([]);
      });

      it("refuses a cross-subject write to an existing thread", async () => {
        const { store, own } = pick();
        const thread = id("takeover");
        await own(thread, alice.subject);
        const messages = threadMessageStore<UIMessage>(store);
        await messages.upsert(alice, thread, message("m_1", "mine"), 0);

        await expect(messages.upsert(bob, thread, message("m_2", "yours"), 1)).rejects.toBeInstanceOf(VendoError);
        await expect(messages.list(alice, thread)).resolves.toHaveLength(1);
      });

      it("refuses a write to a thread that does not exist", async () => {
        const messages = threadMessageStore<UIMessage>(pick().store);
        await expect(messages.upsert(alice, id("orphan"), message("m_1", "nowhere"), 0))
          .rejects.toBeInstanceOf(VendoError);
      });

      it("refuses a message with no id — it is the row's key", async () => {
        const { store, own } = pick();
        const thread = id("noid");
        await own(thread, alice.subject);
        const messages = threadMessageStore<UIMessage>(store);
        await expect(messages.upsert(alice, thread, { id: "" } as UIMessage, 0))
          .rejects.toBeInstanceOf(VendoError);
      });
    });

    /**
     * The approval flip: the runtime re-writes an ALREADY PERSISTED message
     * under its own id, and the transcript must hold one copy of it, not two.
     * Over the wire that is `transcripts.putMessage` doing an edit-by-id.
     *
     * `memory-ops` is excluded because core's reference `putMessage` appends
     * unconditionally — the wire's conformance suite only asserts append, so the
     * reference has no id semantics to edit by. The LIVE console shares that gap
     * (measured: `packages/vendo/src/hosted-transcript.live.test.ts` records it
     * with an `it.fails`), which is why the two backends that DO carry id
     * semantics are the ones checked here: they are what the wire contract has
     * to grow into, not a lower bar this helper settled for.
     */
    describe.each([{ mode: "sql" }, { mode: "local-ops" }])("$mode approval flip", ({ mode }) => {
      it("edits a message in place instead of appending a second copy", async () => {
        const target = modes.find((candidate) => candidate.name === mode)!;
        const thread = `thr_${mode.replace("-", "_")}_flip`;
        await target.own(thread, alice.subject);
        const messages = threadMessageStore<UIMessage>(target.store);
        await messages.upsert(alice, thread, message("m_1", "before", "assistant"), 0);
        await messages.upsert(alice, thread, message("m_2", "after it", "user"), 1);
        await messages.upsert(alice, thread, message("m_1", "approved", "assistant"), 0);

        const listed = await messages.list(alice, thread);
        expect(listed.map((m) => m.id)).toEqual(["m_1", "m_2"]);
        expect(JSON.stringify(listed[0])).toContain("approved");
      });
    });

    /** SQL's per-row CAS has no wire expression: `transcripts.putMessage`
     *  carries no revision. Loud beats a silent downgrade to last-write-wins. */
    describe.each([{ mode: "memory-ops" }, { mode: "local-ops" }])("$mode", ({ mode }) => {
      it("refuses a guarded (expectedRevision) edit rather than quietly clobbering", async () => {
        const target = modes.find((candidate) => candidate.name === mode)!;
        const thread = `thr_${mode.replace("-", "_")}_cas`;
        await target.own(thread, alice.subject);
        const messages = threadMessageStore<UIMessage>(target.store);
        await messages.upsert(alice, thread, message("m_1", "one"), 0);

        await expect(
          messages.upsert(alice, thread, message("m_1", "two"), 0, { expectedRevision: 1 }),
        ).rejects.toMatchObject({ code: "not-implemented" });
      });
    });
  });
}

describe("a store with neither a SQL handle nor a StoreOps surface", () => {
  it("is refused by name, at construction", () => {
    const bare = { ...opsOnlyStore(memoryStoreOps()), ops: undefined };
    expect(() => threadMessageStore(bare)).toThrow(/SQL handle or a StoreOps-capable store/);
  });
});
