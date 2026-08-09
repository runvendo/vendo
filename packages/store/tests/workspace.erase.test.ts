import type { Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { eraseStore } from "../src/erase.js";
import { storeFiles } from "../src/files-store.js";
import { WORKSPACE_INLINE_MAX_BYTES, workspaceStore } from "../src/workspace.js";

// Build contract §3.3: "Both join ERASE_TABLES ... keyed on `owner`." These
// tests are that sentence, run against both tables AND the blobs the
// store-backed files adapter holds for them.

const seed = async (
  store: MadeBackend["store"],
  principal: Principal,
  path: string,
  revisions: string[],
): Promise<void> => {
  const workspace = workspaceStore(store);
  for (const content of revisions) {
    const fs = await workspace.open(principal);
    await fs.writeFile(path, content);
    await fs.commit({ message: `wrote ${path}` });
  }
};

for (const backend of backends()) {
  describe(`${backend.name} workspace erase`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    const workspaceBlobs = async (): Promise<number> => Number(
      (await made.sql(
        "SELECT COUNT(*)::int AS count FROM vendo_blobs WHERE namespace = 'workspace'",
      ))[0]?.["count"],
    );

    const count = async (table: string, where: string, params: unknown[]): Promise<number> => {
      const rows = await made.sql(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where}`, params);
      return Number(rows[0]?.["count"]);
    };

    it("cascades a subject's workspace files, history and blobs, and spares everyone else", async () => {
      const erased: Principal = { kind: "user", subject: "user_ws_erased" };
      const bystander: Principal = { kind: "user", subject: "user_ws_kept" };
      // Two revisions each, so history is non-empty; one file past the inline
      // cap, so a blob exists to strand if the cascade misses it.
      await seed(made.store, erased, "/user/apps/app_e/app.vendo", ["v1", "v2"]);
      await seed(made.store, erased, "/user/files/big.txt", [
        "x".repeat(WORKSPACE_INLINE_MAX_BYTES + 1),
        "y".repeat(WORKSPACE_INLINE_MAX_BYTES + 1),
      ]);
      await seed(made.store, bystander, "/user/apps/app_k/app.vendo", ["theirs", "theirs again"]);

      expect(await count("vendo_workspace_files", "owner = $1", [erased.subject])).toBe(2);
      expect(await count("vendo_workspace_history", "owner = $1", [erased.subject])).toBe(2);
      expect(await count("vendo_blobs", "namespace = 'workspace'", [])).toBeGreaterThan(0);

      const report = await eraseStore(made.store, { files: storeFiles(made.store) }).bySubject(erased.subject);
      expect(report.vendo_workspace_files).toBe(2);
      expect(report.vendo_workspace_history).toBe(2);

      expect(await count("vendo_workspace_files", "owner = $1", [erased.subject])).toBe(0);
      expect(await count("vendo_workspace_history", "owner = $1", [erased.subject])).toBe(0);
      // The over-cap file's live blob and its superseded one both go. They are
      // deleted THROUGH the files adapter (the row's `blob_ref` is the only
      // pointer), so `report.vendo_blobs` — rows the cascade's own SQL deleted —
      // deliberately does not count them: with a host-wired `files:` adapter
      // they would not be vendo_blobs rows at all.
      expect(await count("vendo_blobs", "namespace = 'workspace'", [])).toBe(0);

      // The bystander keeps their files and their history.
      expect(await count("vendo_workspace_files", "owner = $1", [bystander.subject])).toBe(1);
      expect(await count("vendo_workspace_history", "owner = $1", [bystander.subject])).toBe(1);
    });

    it("erases an app's workspace documents with the app, whoever's workspace holds them", async () => {
      const owner: Principal = { kind: "user", subject: "user_ws_by_app" };
      await seed(made.store, owner, "/user/apps/app_drop/app.vendo", ["drop me", "still drop me"]);
      await seed(made.store, owner, "/user/apps/app_keep/app.vendo", ["keep me"]);

      // A user file that merely reads like an app path must survive.
      await seed(made.store, owner, "/user/files/apps/app_drop/notes.md", ["not a document"]);

      const report = await eraseStore(made.store, { files: storeFiles(made.store) }).byApp("app_drop");
      expect(report.vendo_workspace_files).toBe(1);
      expect(report.vendo_workspace_history).toBe(1);

      expect(await count("vendo_workspace_files", "path LIKE '/user/apps/app_drop/%'", [])).toBe(0);
      expect(await count("vendo_workspace_files", "path LIKE '/user/apps/app_keep/%'", [])).toBe(1);
      expect(await count("vendo_workspace_files", "path = '/user/files/apps/app_drop/notes.md'", [])).toBe(1);
    });

    it("erases the app subtree's ROOT row, at both the /user and the /orgs anchor", async () => {
      // The anchors were slash-suffixed only, so a row at exactly
      // `/user/apps/<id>` or `/orgs/<org>/apps/<id>` — the very path core's
      // `appOfOrgPath` says the app's grants govern — outlived the erase.
      const owner: Principal = { kind: "user", subject: "user_ws_root" };
      await seed(made.store, owner, "/user/apps/app_root", ["the root, as a row"]);
      await made.sql(
        "INSERT INTO vendo_workspace_files (path, owner, content, bytes) VALUES ($1, $2, $3, $4)",
        ["/orgs/acme/apps/app_root", "acme", "the org's root row", 18],
      );
      // ...and a sibling whose id merely starts the same must survive.
      await seed(made.store, owner, "/user/apps/app_root2", ["a different app"]);

      await eraseStore(made.store, { files: storeFiles(made.store) }).byApp("app_root");
      expect(await count("vendo_workspace_files", "path = '/user/apps/app_root'", [])).toBe(0);
      expect(await count("vendo_workspace_files", "path = '/orgs/acme/apps/app_root'", [])).toBe(0);
      expect(await count("vendo_workspace_files", "path = '/user/apps/app_root2'", [])).toBe(1);
    });

    // N3b (verifier): with blob deletion moved behind the adapter, EraseReport
    // stopped counting workspace content in EITHER configuration — a GDPR erase
    // has to be auditable, so the report carries its own count.
    it("counts the workspace content it deleted, wired adapter or not", async () => {
      const owner: Principal = { kind: "user", subject: "user_ws_audit" };
      const big = (marker: string): string => marker.repeat(WORKSPACE_INLINE_MAX_BYTES + 1);
      // Two blob-backed revisions plus one inline file.
      await seed(made.store, owner, "/user/files/audited.bin", [big("a"), big("b")]);
      await seed(made.store, owner, "/user/memory/inline.md", ["small enough to inline"]);

      const report = await eraseStore(made.store, { files: storeFiles(made.store) })
        .bySubject(owner.subject);
      expect(report.vendo_workspace_files).toBe(2);
      expect(report.vendo_workspace_history).toBe(1);
      // Every piece of content erased, inline OR blob: the two blob revisions of
      // audited.bin plus the one inline doc — objects, never bytes.
      expect(report.workspace_content_objects).toBe(3);
    });

    it("counts content deleted through a host-wired adapter too", async () => {
      const owner: Principal = { kind: "user", subject: "user_ws_audit_wired" };
      const held = new Map<string, Uint8Array>();
      const files = {
        async put(key: string, bytes: Uint8Array) { held.set(key, bytes); },
        async get(key: string) {
          const bytes = held.get(key);
          return bytes === undefined ? undefined : { bytes };
        },
        async delete(key: string) { held.delete(key); },
      };
      const workspace = workspaceStore(made.store, { files });
      for (const content of ["x".repeat(WORKSPACE_INLINE_MAX_BYTES + 1), "y".repeat(WORKSPACE_INLINE_MAX_BYTES + 1)]) {
        const fs = await workspace.open(owner);
        await fs.writeFile("/user/files/wired.bin", content);
        await fs.commit();
      }
      expect(held.size).toBe(2);

      const report = await eraseStore(made.store, { files }).bySubject(owner.subject);
      expect(report.workspace_content_objects).toBe(2);
      // The host's bucket is actually emptied, not just the rows.
      expect(held.size).toBe(0);
    });

    // F3 (verifier): erase.byApp deleted rows with no blob cascade at all.
    it("deletes an app's blobs when the app is erased", async () => {
      const owner: Principal = { kind: "user", subject: "user_ws_blob_app" };
      const big = "q".repeat(WORKSPACE_INLINE_MAX_BYTES + 1);
      const before = await workspaceBlobs();
      await seed(made.store, owner, "/user/apps/app_blob_drop/app.vendo", [big, `${big}!`]);
      // The live revision plus the superseded one.
      expect(await workspaceBlobs()).toBe(before + 2);

      const report = await eraseStore(made.store, { files: storeFiles(made.store) }).byApp("app_blob_drop");
      expect(report.vendo_workspace_files).toBe(1);
      expect(await workspaceBlobs()).toBe(before);
    });

    // F15 (verifier): keys derived from owner+path+revision were guessable
    // across tenants. A blob key is now a random id; the row is the only pointer.
    it("mints unguessable blob keys that carry no owner or path", async () => {
      const owner: Principal = { kind: "user", subject: "user_ws_key_shape" };
      const path = "/user/files/secret-name.txt";
      await seed(made.store, owner, path, ["k".repeat(WORKSPACE_INLINE_MAX_BYTES + 1)]);
      const refs = (await made.sql(
        "SELECT blob_ref FROM vendo_workspace_files WHERE path = $1",
        [path],
      )).map((row) => String(row["blob_ref"]));

      expect(refs).toHaveLength(1);
      const ref = refs[0] ?? "";
      for (const secret of [owner.subject, "secret-name", path, "r1"]) {
        expect(ref).not.toContain(secret);
        expect(ref).not.toContain(Buffer.from(secret, "utf8").toString("base64url"));
      }
    });
  });
}
