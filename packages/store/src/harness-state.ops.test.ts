/**
 * Durable harness state (build contract §1.3), proven against every backend it
 * can sit on — the transcript suite's sibling, same shape and same reason.
 *
 * `harnessStateStore` demanded a SQL handle, which is why a key-only deployment
 * re-seeded a session-owning harness on every turn. It picks a backend now
 * (`backendOf`); this file is the proof that §1.3's rules — one slot per thread,
 * keyed by its OWNER, a foreign harness DESTROYING rather than shadowing it, and
 * the slot dying with its thread — read identically whichever backend answers.
 */
import { VendoError, type Principal, type StoreOps } from "@vendoai/core";
import { memoryStoreOps } from "@vendoai/core/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { createStoreOps, harnessStateStore, threadStore, type VendoStore } from "./index.js";

const alice: Principal = { kind: "user", subject: "user_alice" };

/** Not a handle `@vendoai/store` minted — the shape a hosted store presents. */
function opsOnlyStore(ops: StoreOps): VendoStore {
  const unused = (what: string): never => {
    throw new Error(`the harness-state helper must not reach ${what}`);
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
  removeThread(id: string, subject: string): Promise<void>;
}

/** Ids are namespaced per mode because `local-ops` and `sql` share one database. */
const modesFor = (made: MadeBackend): Mode[] => {
  const viaOps = (name: string, ops: StoreOps): Mode => ({
    name,
    store: opsOnlyStore(ops),
    own: async (id, subject) => { await ops.transcripts.putThread({ id, subject, messages: [] }); },
    removeThread: async (id) => { await ops.transcripts.deleteThread(id); },
  });
  return [
    {
      name: "sql",
      store: made.store,
      own: async (id, subject) => { await threadStore(made.store).put({ kind: "user", subject }, { id, messages: [] }); },
      removeThread: async (id, subject) => { await threadStore(made.store).delete({ kind: "user", subject }, id); },
    },
    viaOps("memory-ops", memoryStoreOps()),
    viaOps("local-ops", createStoreOps(made.store)),
  ];
};

for (const backend of backends()) {
  describe(`${backend.name} durable harness state across backends (§1.3, design D1)`, () => {
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
      const id = (suffix: string): string => `thr_hs_${mode.replace("-", "_")}_${suffix}`;

      it("survives the handle: a value set on one reads back on another", async () => {
        const { store, own } = pick();
        const thread = id("durable");
        await own(thread, alice.subject);
        await harnessStateStore(store).set(thread, "claude-code", "sess_1");

        expect(await harnessStateStore(store).get(thread, "claude-code")).toBe("sess_1");
      });

      it("a foreign harness CLEARS the slot rather than shadowing it", async () => {
        const { store, own } = pick();
        const thread = id("swap");
        await own(thread, alice.subject);
        const states = harnessStateStore(store);
        await states.set(thread, "claude-code", "sess_swap");

        expect(await states.get(thread, "vendo")).toBeUndefined();
        // Destroyed, not hidden: swapping back must not resurrect a session the
        // conversation has outgrown.
        expect(await states.get(thread, "claude-code")).toBeUndefined();
      });

      it("set(undefined) deletes", async () => {
        const { store, own } = pick();
        const thread = id("delete");
        await own(thread, alice.subject);
        const states = harnessStateStore(store);
        await states.set(thread, "claude-code", "sess_delete");
        await states.set(thread, "claude-code", undefined);

        expect(await states.get(thread, "claude-code")).toBeUndefined();
      });

      it("clear drops the thread's state whoever owns it", async () => {
        const { store, own } = pick();
        const thread = id("clear");
        await own(thread, alice.subject);
        const states = harnessStateStore(store);
        await states.set(thread, "claude-code", "sess_clear");
        await states.clear(thread);

        expect(await states.get(thread, "claude-code")).toBeUndefined();
      });

      it("one thread's state is never another's", async () => {
        const { store, own } = pick();
        await own(id("a"), alice.subject);
        await own(id("b"), alice.subject);
        const states = harnessStateStore(store);
        await states.set(id("a"), "claude-code", "sess_a");
        await states.set(id("b"), "claude-code", "sess_b");

        expect(await states.get(id("a"), "claude-code")).toBe("sess_a");
        expect(await states.get(id("b"), "claude-code")).toBe("sess_b");
      });

      it("a thread nobody owns cannot hold state — the row would outlive the erase cascade", async () => {
        await expect(harnessStateStore(pick().store).set(id("orphan"), "claude-code", "x"))
          .rejects.toBeInstanceOf(VendoError);
      });

      it("reads a thread that never existed as no state, not an error", async () => {
        await expect(harnessStateStore(pick().store).get(id("absent"), "claude-code"))
          .resolves.toBeUndefined();
      });

      it("deleting the thread deletes its harness state — no ref outlives its thread", async () => {
        const { store, own, removeThread } = pick();
        const thread = id("gone");
        await own(thread, alice.subject);
        const states = harnessStateStore(store);
        await states.set(thread, "claude-code", "sess_gone");
        await removeThread(thread, alice.subject);

        expect(await states.get(thread, "claude-code")).toBeUndefined();
      });
    });
  });
}

describe("a store with neither a SQL handle nor a StoreOps surface", () => {
  it("is refused by name, at construction", () => {
    const bare = { ...opsOnlyStore(memoryStoreOps()), ops: undefined };
    expect(() => harnessStateStore(bare)).toThrow(/SQL handle or a StoreOps-capable store/);
  });
});
