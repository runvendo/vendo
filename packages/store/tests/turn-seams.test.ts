import type { Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { harnessStateStore } from "../src/harness-state.js";
import { createStoreOps } from "../src/ops.js";
import type { VendoStore as StoreHandle } from "../src/store.js";
import { workspaceIndexPage } from "../src/workspace-ops-rows.js";
import { workspaceStore } from "../src/workspace.js";

/**
 * The seams that let ONE `turn.load` stand in for a turn's opening reads: an
 * index the caller already read, and a harness slot the caller already read.
 *
 * Proven the only way a prefetch can be proven honest — against the un-batched
 * read, on the same store, for the same caller. The prefetched values are
 * sourced from the REAL `turn.load`, so the producer (`ops.turn`) and the
 * consumer (`workspaceStore.open` / `harnessStateStore.resume`) are both live:
 * a seam that reshaped a row, or an envelope that answered a different one,
 * fails here rather than opening a turn on a workspace that is missing files.
 */

const dana: Principal = { kind: "user", subject: "dana" };

/** A handle with NO local database and the ops instead — a hosted store's shape. */
const opsBacked = (store: StoreHandle): StoreHandle => ({
  records: (collection) => store.records(collection),
  blobs: (namespace) => store.blobs(namespace),
  ensureSchema: () => store.ensureSchema(),
  async close() {},
  raw() { throw new Error("a hosted store has no local database handle"); },
  ops: createStoreOps(store),
});

describe("workspaceIndexPage refuses a page that did not finish", () => {
  it("answers metas for an exhausted page and UNDEFINED when a cursor remains", () => {
    const entries = [{ path: "/user/a.md", bytes: 3, revision: 2, updatedAt: "2026-01-01T00:00:00.000Z" }];

    expect(workspaceIndexPage({ entries }, "dana")).toEqual([
      { path: "/user/a.md", owner: "dana", bytes: 3, revision: 2, updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    // Half an index is not an index: the caller must read it the ordinary way.
    expect(workspaceIndexPage({ entries, cursor: "c_1" }, "dana")).toBeUndefined();
  });
});

for (const backend of backends()) {
  describe(`${backend.name} the turn envelope's prefetch seams`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    const hosted = (): StoreHandle => opsBacked(made.store);

    it("an index from turn.load opens the same workspace the un-batched read opens", async () => {
      const store = hosted();
      const staging = await workspaceStore(store).open(dana);
      await staging.writeFile("/user/notes/plan.md", "the plan");
      await staging.writeFile("/user/notes/second.md", "and more");
      await staging.commit({ message: "two files" });

      const loaded = await store.ops!.turn!.load({
        thread: { id: "thr_seam" },
        index: { owner: dana.subject },
      });
      // The envelope answered only what it was asked for.
      expect("read" in loaded).toBe(false);

      const index = workspaceIndexPage(loaded.index, dana.subject);
      expect(index).toBeDefined();
      const batched = await workspaceStore(store).open(dana, { index });
      const direct = await workspaceStore(store).open(dana);

      expect(batched.getAllPaths().sort()).toEqual(direct.getAllPaths().sort());
      expect(await batched.readFile("/user/notes/plan.md")).toBe("the plan");
    });

    it("a harness slot from turn.load resumes exactly what get() answers", async () => {
      const store = hosted();
      const thread = "thr_seam_state";
      await store.ops!.transcripts.putThread({ id: thread, subject: dana.subject, messages: [] });
      const states = harnessStateStore(store);
      await states.set(thread, "claude-code", "sess_seam");

      const loaded = await store.ops!.turn!.load({
        thread: { id: thread },
        index: { owner: dana.subject },
        harness: { appId: `harness_state:${thread}`, subject: dana.subject },
      });

      expect(await states.resume(thread, "claude-code", loaded.harness, dana.subject))
        .toBe(await states.get(thread, "claude-code", dana.subject));
      expect(await states.resume(thread, "claude-code", loaded.harness, dana.subject)).toBe("sess_seam");
    });

    it("resume keeps get's clearing rule: a foreign harness DESTROYS the slot", async () => {
      const store = hosted();
      const thread = "thr_seam_swap";
      await store.ops!.transcripts.putThread({ id: thread, subject: dana.subject, messages: [] });
      const states = harnessStateStore(store);
      await states.set(thread, "claude-code", "sess_swap");
      const loaded = await store.ops!.turn!.load({
        thread: { id: thread },
        index: { owner: dana.subject },
        harness: { appId: `harness_state:${thread}`, subject: dana.subject },
      });

      expect(await states.resume(thread, "vendo", loaded.harness, dana.subject)).toBeUndefined();
      // Destroyed, not hidden — the same §1.3 rule `get` enforces.
      expect(await states.get(thread, "claude-code", dana.subject)).toBeUndefined();
    });
  });
}
