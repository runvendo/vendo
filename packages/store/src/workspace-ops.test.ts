import type { Membership, Principal } from "@vendoai/core";
import { VendoError } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "./backends.test-util.js";
import { createStoreOps } from "./ops.js";
import type { VendoStore as StoreHandle } from "./store.js";
import { workspaceStore } from "./workspace.js";

/**
 * T1/D3 — the workspace façade over the 32-op contract instead of a SQL handle.
 *
 * The seam is real on both sides: the PRODUCER is `WorkspaceStoreFs` driving
 * `workspaceOpsRows`, and the CONSUMER is `createStoreOps` writing this store's
 * own Postgres. Neither half is stubbed, so a disagreement between them shows
 * up here — and the SQL-backed façade reads the same rows back, which is the
 * parity claim ("hosted is indistinguishable from local") stated as a test.
 */

const dana: Principal = { kind: "user", subject: "dana" };
const kim: Principal = { kind: "user", subject: "kim" };
const acme: Membership[] = [{ org: "acme" }];

/** A store handle with NO local database and the 32 ops instead — exactly the
    shape a hosted store presents. The record/blob doors still delegate to the
    real store, because that is what the hosted store's own doors do. */
const opsBacked = (store: StoreHandle): StoreHandle => ({
  records: (collection) => store.records(collection),
  blobs: (namespace) => store.blobs(namespace),
  ensureSchema: () => store.ensureSchema(),
  async close() { /* the ops handle owns no local resource */ },
  raw() { throw new Error("a hosted store has no local database handle"); },
  ops: createStoreOps(store),
});

for (const backend of backends()) {
  describe(`${backend.name} the workspace over StoreOps`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    /** The façade a hosted deployment gets. */
    const hosted = () => workspaceStore(opsBacked(made.store));
    /** The SAME façade over the SAME rows with a database handle instead of
        the 32 ops — the local answer every hosted answer is compared against. */
    const local = () => workspaceStore(made.store);

    it("commits through the ops backend into the ordinary workspace rows", async () => {
      const path = "/user/notes/plan.md";
      const first = await hosted().open(dana);
      await first.writeFile(path, "the plan");
      expect(await first.commit({ message: "planned" })).toEqual({ status: "ok", changed: [path] });

      // Next turn — a different façade instance — reads it back byte for byte.
      expect(await (await hosted().open(dana)).readFile(path)).toBe("the plan");
      // The row is the ordinary workspace row, under the writer as its owner.
      // Its content is the file's JSON, because the contract carries JSON
      // documents (a text file is a JSON string, binary is the base64
      // envelope) — the round trip that matters is façade → ops → row →
      // façade, and it is exact.
      expect(await made.sql(
        "SELECT owner, content FROM vendo_workspace_files WHERE path = $1",
        [path],
      )).toEqual([{ owner: "dana", content: '"the plan"' }]);
    });

    it("keeps two owners' drawers apart at the same path", async () => {
      const path = "/user/shared.md";
      const mine = await hosted().open(dana);
      await mine.writeFile(path, "dana's");
      await mine.commit();
      const theirs = await hosted().open(kim);
      await theirs.writeFile(path, "kim's");
      await theirs.commit();

      expect(await (await hosted().open(dana)).readFile(path)).toBe("dana's");
      expect(await (await hosted().open(kim)).readFile(path)).toBe("kim's");
      const sam = await hosted().open({ kind: "user", subject: "sam" });
      expect(await sam.exists(path)).toBe(false);
    });

    it("carries bytes that are not text through the base64 envelope", async () => {
      const path = "/user/uploads/pixel.png";
      // A PNG header: valid bytes, invalid UTF-8, with a NUL in it.
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
      const fs = await hosted().open(dana);
      await fs.writeFile(path, bytes);
      await fs.commit();

      const next = await hosted().open(dana);
      expect([...(await next.readFileBuffer(path))]).toEqual([...bytes]);
      expect((await next.stat(path)).size).toBeGreaterThan(0);
    });

    it("removes a file with a tombstone, and the next turn does not see it", async () => {
      const path = "/user/temp.md";
      const seed = await hosted().open(dana);
      await seed.writeFile(path, "temporary");
      await seed.commit();

      const cleaner = await hosted().open(dana);
      await cleaner.rm(path);
      expect(await cleaner.commit()).toEqual({ status: "ok", changed: [path] });

      const next = await hosted().open(dana);
      expect(await next.exists(path)).toBe(false);
      expect(await made.sql("SELECT path FROM vendo_workspace_files WHERE path = $1", [path])).toEqual([]);
    });

    it("answers an /orgs commit that lost its base with the conflict branch", async () => {
      const path = "/orgs/acme/files/roadmap.md";
      const seed = await hosted().open(dana, { memberships: acme });
      await seed.writeFile(path, "v1");
      await seed.commit();

      // Two turns open on the same revision; the second commits against a base
      // that has moved.
      const stale = await hosted().open(dana, { memberships: acme });
      const fresh = await hosted().open(kim, { memberships: acme });
      await fresh.writeFile(path, "v2 from kim");
      expect(await fresh.commit()).toEqual({ status: "ok", changed: [path] });

      await stale.writeFile(path, "v2 from dana");
      expect(await stale.commit()).toEqual({ status: "conflict", paths: [path] });
      // The colleague's edit stands.
      expect(await (await hosted().open(dana, { memberships: acme })).readFile(path)).toBe("v2 from kim");
    });

    /** S3 — the path legs. The claim is not "undo works over the wire" but
        "the hosted façade answers what the SQL façade answers", so every
        assertion here is checked against `local()`, the same façade over the
        same rows with a database handle instead of the 32 ops. */
    it("walks one path back through its versions, exactly as the SQL façade does", async () => {
      const path = "/user/notes/history.md";
      for (const content of ["v1", "v2", "v3"]) {
        const fs = await hosted().open(dana);
        await fs.writeFile(path, content);
        await fs.commit({ message: `wrote ${content}` });
      }
      const caller = { principal: dana };

      // Two superseded versions behind the head, newest first — the same count
      // and order the SQL façade reports for the same three commits.
      const versions = await hosted().history(caller, path);
      expect(versions).toHaveLength(2);
      expect(versions.map((entry) => entry.revision)).toEqual([2, 1]);
      expect(await local().history(caller, path)).toHaveLength(2);

      expect(await hosted().undo(caller, path)).toMatchObject({ status: "ok" });
      expect(await (await hosted().open(dana)).readFile(path)).toBe("v2");
      expect(await hosted().undo(caller, path)).toMatchObject({ status: "ok" });
      expect(await (await hosted().open(dana)).readFile(path)).toBe("v1");

      // One step past the oldest version there is nothing left to restore, and
      // the file keeps what the last undo put there.
      expect(await hosted().undo(caller, path)).toEqual({ status: "empty" });
      expect(await (await hosted().open(dana)).readFile(path)).toBe("v1");
      expect(await hosted().history(caller, path)).toEqual([]);
    });

    it("undoes one path without disturbing the others in the same commit", async () => {
      const [kept, undone] = ["/user/pair/kept.md", "/user/pair/undone.md"];
      for (const version of ["v1", "v2"]) {
        const fs = await hosted().open(dana);
        await fs.writeFile(kept, `${kept} ${version}`);
        await fs.writeFile(undone, `${undone} ${version}`);
        await fs.commit();
      }

      expect(await hosted().undo({ principal: dana }, undone)).toMatchObject({ status: "ok" });
      const next = await hosted().open(dana);
      expect(await next.readFile(undone)).toBe(`${undone} v1`);
      expect(await next.readFile(kept)).toBe(`${kept} v2`);
    });

    /** A file with one version has nothing behind it — the SQL backend records
        no history row for a create, so both façades say `empty` and the file
        stays. (The commit-ledger level below the façade DOES remove it: that is
        `ops.workspace.undo({ path })`, and the conformance suite pins it.) */
    it("answers empty for a file that has only ever been created", async () => {
      const path = "/user/fresh.md";
      const fs = await hosted().open(dana);
      await fs.writeFile(path, "only version");
      await fs.commit();
      const caller = { principal: dana };

      expect(await hosted().history(caller, path)).toEqual(await local().history(caller, path));
      expect(await hosted().undo(caller, path)).toEqual({ status: "empty" });
      expect(await local().undo(caller, path)).toEqual({ status: "empty" });
      expect(await (await hosted().open(dana)).readFile(path)).toBe("only version");
    });

    it("brings back a file the agent deleted", async () => {
      const path = "/user/deleted.md";
      const seed = await hosted().open(dana);
      await seed.writeFile(path, "still needed");
      await seed.commit();
      const cleaner = await hosted().open(dana);
      await cleaner.rm(path);
      await cleaner.commit();

      expect(await hosted().undo({ principal: dana }, path)).toMatchObject({ status: "ok" });
      expect(await (await hosted().open(dana)).readFile(path)).toBe("still needed");
    });

    it("keeps one owner's path history and undo out of another's", async () => {
      const path = "/user/private.md";
      for (const [who, text] of [[dana, "dana"], [kim, "kim"]] as const) {
        for (const version of ["v1", "v2"]) {
          const fs = await hosted().open(who);
          await fs.writeFile(path, `${text} ${version}`);
          await fs.commit();
        }
      }

      expect(await hosted().history({ principal: dana }, path)).toHaveLength(1);
      expect(await hosted().undo({ principal: dana }, path)).toMatchObject({ status: "ok" });
      expect(await (await hosted().open(dana)).readFile(path)).toBe("dana v1");
      // The other drawer did not move.
      expect(await (await hosted().open(kim)).readFile(path)).toBe("kim v2");

      // And a stranger's undo of the same path finds nothing of theirs to undo.
      const sam = { kind: "user", subject: "sam" } as const;
      expect(await hosted().undo({ principal: sam }, path)).toEqual({ status: "empty" });
      expect(await (await hosted().open(dana)).readFile(path)).toBe("dana v1");
    });

    it("still refuses to move an app between mounts — that runs server-side", async () => {
      await expect(
        hosted().moveApp("app_1", { kind: "user", subject: "dana" }, { kind: "org", org: "acme" }),
      ).rejects.toThrow(VendoError);
    });
  });
}
