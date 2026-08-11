import type { Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appStore } from "../src/helpers/apps.js";
import { appFixture } from "../src/fixtures.test-util.js";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { workspaceStore } from "../src/workspace.js";

/** Build contract §9.5 — promote is the SECOND sanctioned door through 02-store
    §2's "rows never cross subjects" (the first is anon→signed-in adoption): the
    canonical app moves into the org, documents and history following. */

const dana: Principal = { kind: "user", subject: "dana" };

for (const backend of backends()) {
  describe(`${backend.name} build contract §9.5 — promote`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    it("flips the row subject to the org and rewrites the app's workspace paths", async () => {
      const app = "app_promoted";
      await appStore(made.store).put(dana, appFixture(app));
      const workspace = workspaceStore(made.store);
      const fs = await workspace.open(dana);
      await fs.writeFile(`/user/apps/${app}/app.vendo`, "page: v1");
      await fs.commit();
      // A second revision, so history has something to follow.
      const again = await workspace.open(dana);
      await again.writeFile(`/user/apps/${app}/app.vendo`, "page: v2");
      await again.commit();
      // A file that is NOT this app's must stay exactly where it is.
      const other = await workspace.open(dana);
      await other.writeFile("/user/memory/notes.md", "mine");
      await other.commit();

      // Documents first, the row last — the order the umbrella's promote seam
      // uses, so any failure leaves the app wholly personal (§9.5).
      await workspace.moveApp(app, { kind: "user", subject: "dana" }, { kind: "org", org: "acme" });
      await appStore(made.store).promote(app, "dana", "acme");

      expect(await appStore(made.store).get(app)).toMatchObject({ subject: "acme" });
      expect(await made.sql(
        "SELECT path, owner FROM vendo_workspace_files ORDER BY path",
      )).toEqual([
        { path: "/orgs/acme/apps/app_promoted/app.vendo", owner: "acme" },
        { path: "/user/memory/notes.md", owner: "dana" },
      ]);
      // History follows, or the trail would point at rows nobody can reach.
      expect(await made.sql(
        "SELECT DISTINCT path, owner FROM vendo_workspace_history",
      )).toEqual([{ path: "/orgs/acme/apps/app_promoted/app.vendo", owner: "acme" }]);
    });

    /** The app's own ROOT row — the path at exactly `/user/apps/<appId>`, with
        no trailing slash. Core's `appOfOrgPath` says the app's grants govern it
        (`erase.byApp` matches it for the same reason), so a promote that leaves
        it behind strands a row of the org's app in the promoter's `/user`. */
    it("moves the row at EXACTLY the app path, not only its subtree", async () => {
      const app = "app_root_row";
      const workspace = workspaceStore(made.store);
      const fs = await workspace.open(dana);
      await fs.writeFile(`/user/apps/${app}`, "the app itself");
      await fs.commit();

      expect(await workspace.moveApp(
        app,
        { kind: "user", subject: "dana" },
        { kind: "org", org: "acme" },
      )).toBe(1);

      expect(await made.sql(
        "SELECT path, owner FROM vendo_workspace_files WHERE path LIKE $1",
        [`/%/apps/${app}%`],
      )).toEqual([{ path: `/orgs/acme/apps/${app}`, owner: "acme" }]);
    });

    it("refuses a destination collision at exactly the app path too", async () => {
      const app = "app_root_clash";
      const workspace = workspaceStore(made.store);
      await made.sql(
        "INSERT INTO vendo_workspace_files (path, owner, content, bytes) VALUES ($1, $2, $3, $4)",
        [`/orgs/acme/apps/${app}`, "acme", "somebody else's", 16],
      );
      const mine = await workspace.open(dana);
      await mine.writeFile(`/user/apps/${app}`, "mine");
      await mine.commit();

      await expect(workspace.moveApp(
        app,
        { kind: "user", subject: "dana" },
        { kind: "org", org: "acme" },
      )).rejects.toMatchObject({ code: "conflict" });
      expect(await made.sql(
        "SELECT owner FROM vendo_workspace_files WHERE path = $1",
        [`/user/apps/${app}`],
      )).toEqual([{ owner: "dana" }]);
    });

    it("refuses to promote a row that belongs to someone else", async () => {
      const app = "app_not_yours";
      await appStore(made.store).put(dana, appFixture(app));
      await expect(appStore(made.store).promote(app, "mal", "acme")).rejects.toMatchObject({
        code: "conflict",
      });
      expect(await appStore(made.store).get(app)).toMatchObject({ subject: "dana" });
    });

    it("refuses a destination collision in the caller's own words, moving nothing", async () => {
      // The org workspace already holds documents at this app's subtree — the
      // (path, owner) primary key would reject the move mid-statement, so the
      // move refuses BEFORE it touches a row (§9.5 is all-or-nothing).
      const app = "app_clash";
      const workspace = workspaceStore(made.store);
      // Left behind by an app that used to live there — seeded as rows, since
      // no live caller can write another app's subtree (that is §9.3's job).
      await made.sql(
        "INSERT INTO vendo_workspace_files (path, owner, content, bytes) VALUES ($1, $2, $3, $4)",
        [`/orgs/acme/apps/${app}/app.vendo`, "acme", "somebody else's", 16],
      );

      const mine = await workspace.open(dana);
      await mine.writeFile(`/user/apps/${app}/app.vendo`, "mine");
      await mine.commit();

      await expect(workspace.moveApp(
        app,
        { kind: "user", subject: "dana" },
        { kind: "org", org: "acme" },
      )).rejects.toMatchObject({ code: "conflict" });
      // Nothing moved: the personal copy is exactly where it was.
      expect(await made.sql(
        "SELECT owner FROM vendo_workspace_files WHERE path = $1",
        [`/user/apps/${app}/app.vendo`],
      )).toEqual([{ owner: "dana" }]);
    });

    it("moves an app's documents BACK, so a failed flip can be compensated", async () => {
      // The umbrella's promote seam moves documents first and flips the row
      // last; when the flip fails it must be able to put the documents back,
      // or the app would be left half-personal.
      const app = "app_roundtrip";
      const workspace = workspaceStore(made.store);
      const fs = await workspace.open(dana);
      await fs.writeFile(`/user/apps/${app}/app.vendo`, "page: v1");
      await fs.commit();

      const personal = { kind: "user", subject: "dana" } as const;
      const team = { kind: "org", org: "acme" } as const;
      expect(await workspace.moveApp(app, personal, team)).toBe(1);
      expect(await workspace.moveApp(app, team, personal)).toBe(1);
      expect(await made.sql(
        "SELECT path, owner FROM vendo_workspace_files WHERE path LIKE $1",
        [`/%/apps/${app}/%`],
      )).toEqual([{ path: `/user/apps/${app}/app.vendo`, owner: "dana" }]);
    });
  });
}
