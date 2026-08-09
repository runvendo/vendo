import { VendoError, type Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { eraseStore, harnessStateStore, storeFiles, threadStore } from "../src/index.js";

const alice: Principal = { kind: "user", subject: "user_alice" };

for (const backend of backends()) {
  describe(`${backend.name} durable harness state (build contract §1.3)`, () => {
    let made: MadeBackend;
    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    const own = async (id: string, principal: Principal = alice): Promise<void> => {
      await threadStore(made.store).put(principal, { id, messages: [] });
    };

    it("survives the process: a value set on one store handle reads back on another", async () => {
      await own("thr_durable");
      await harnessStateStore(made.store).set("thr_durable", "claude-code", "sess_1");
      // A FRESH handle — the memory implementation this replaces would answer
      // undefined here, which is the whole point of the lane.
      const reread = harnessStateStore(made.store);
      expect(await reread.get("thr_durable", "claude-code")).toBe("sess_1");
    });

    it("a foreign harness CLEARS the slot rather than shadowing it (§1.3)", async () => {
      await own("thr_swap");
      const states = harnessStateStore(made.store);
      await states.set("thr_swap", "claude-code", "sess_swap");
      expect(await states.get("thr_swap", "vendo")).toBeUndefined();
      // Destroyed, not hidden: swapping back must not resurrect a session the
      // conversation has outgrown.
      expect(await states.get("thr_swap", "claude-code")).toBeUndefined();
    });

    it("set(undefined) deletes", async () => {
      await own("thr_delete");
      const states = harnessStateStore(made.store);
      await states.set("thr_delete", "claude-code", "sess_delete");
      await states.set("thr_delete", "claude-code", undefined);
      expect(await states.get("thr_delete", "claude-code")).toBeUndefined();
    });

    it("clear drops the thread's state whoever owns it", async () => {
      await own("thr_clear");
      const states = harnessStateStore(made.store);
      await states.set("thr_clear", "claude-code", "sess_clear");
      await states.clear("thr_clear");
      expect(await states.get("thr_clear", "claude-code")).toBeUndefined();
    });

    it("one thread's state is never another's", async () => {
      await own("thr_a");
      await own("thr_b");
      const states = harnessStateStore(made.store);
      await states.set("thr_a", "claude-code", "sess_a");
      await states.set("thr_b", "claude-code", "sess_b");
      expect(await states.get("thr_a", "claude-code")).toBe("sess_a");
      expect(await states.get("thr_b", "claude-code")).toBe("sess_b");
    });

    it("a thread nobody owns cannot hold state — the row would outlive the erase cascade", async () => {
      await expect(harnessStateStore(made.store).set("thr_orphan", "claude-code", "x"))
        .rejects.toBeInstanceOf(VendoError);
    });

    it("deleting the thread deletes its harness state — no ref outlives its thread", async () => {
      await own("thr_gone");
      const states = harnessStateStore(made.store);
      await states.set("thr_gone", "claude-code", "sess_gone");
      await threadStore(made.store).delete(alice, "thr_gone");
      expect(await states.get("thr_gone", "claude-code")).toBeUndefined();
    });

    it("a foreign principal's failed thread delete leaves the harness state alone", async () => {
      const mallory: Principal = { kind: "user", subject: "user_mallory" };
      await own("thr_kept");
      const states = harnessStateStore(made.store);
      await states.set("thr_kept", "claude-code", "sess_kept");
      // The delete is subject-guarded, so nothing happens — including the sweep.
      await threadStore(made.store).delete(mallory, "thr_kept");
      expect(await states.get("thr_kept", "claude-code")).toBe("sess_kept");
    });

    it("erasing the subject erases their harness state", async () => {
      const carol: Principal = { kind: "user", subject: "user_carol" };
      await own("thr_carol", carol);
      const states = harnessStateStore(made.store);
      await states.set("thr_carol", "claude-code", "sess_carol");
      await eraseStore(made.store, { files: storeFiles(made.store) }).bySubject("user_carol");
      expect(await states.get("thr_carol", "claude-code")).toBeUndefined();
    });
  });
}
