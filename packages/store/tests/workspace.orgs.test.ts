import type { Membership, Principal } from "@vendoai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appAccess } from "../src/helpers/app-access.js";
import { appStore } from "../src/helpers/apps.js";
import { appFixture } from "../src/fixtures.test-util.js";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import { workspaceStore } from "../src/workspace.js";

/** Build contract §9.7 — `/orgs` mounts, per-app subtree visibility, and the
    FIRST construction of the CommitResult conflict branch. */

const dana: Principal = { kind: "user", subject: "dana" };
const kim: Principal = { kind: "user", subject: "kim" };
const acme: Membership[] = [{ org: "acme" }];
const acmeAdmin: Membership[] = [{ org: "acme", admin: true }];

const ctxOf = (principal: Principal, memberships: Membership[] = []) => ({
  principal,
  memberships,
  venue: "app" as const,
  presence: "present" as const,
  sessionId: `s_${principal.subject}`,
});

for (const backend of backends()) {
  describe(`${backend.name} build contract §9.7 — /orgs mounts`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    const workspace = () => workspaceStore(made.store);

    it("mounts only the orgs the host asserted this request", async () => {
      const asserted = await workspace().open(dana, { memberships: acme });
      expect(await asserted.readdir("/")).toEqual(["host", "orgs", "user"]);
      expect(await asserted.readdir("/orgs")).toEqual(["acme"]);

      // Nothing asserted ⇒ no /orgs mount at all: the same façade a
      // single-player deployment has always had.
      const solo = await workspace().open(dana);
      expect(await solo.readdir("/")).toEqual(["host", "user"]);
      await expect(solo.writeFile("/orgs/acme/files/x", "no")).rejects.toThrow(/EACCES/);
    });

    it("writes an org file under the ORG's owner, not the writer's", async () => {
      const fs = await workspace().open(dana, { memberships: acme });
      await fs.writeFile("/orgs/acme/files/plan.md", "the plan");
      expect(await fs.commit()).toEqual({ status: "ok", changed: ["/orgs/acme/files/plan.md"] });
      expect(await made.sql(
        "SELECT owner FROM vendo_workspace_files WHERE path = $1",
        ["/orgs/acme/files/plan.md"],
      )).toEqual([{ owner: "acme" }]);

      // Another member of the same org reads the same file — that is the whole
      // point of the mount.
      const theirs = await workspace().open(kim, { memberships: acme });
      expect(await theirs.readFile("/orgs/acme/files/plan.md")).toBe("the plan");
    });

    it("shows an org app's subtree only to callers who can see the app", async () => {
      const app = "app_orgvis";
      await appStore(made.store).put({ kind: "user", subject: "acme" }, appFixture(app));
      const admin = ctxOf(dana, acmeAdmin);
      await appAccess(made.store).grant(admin, app, "user:kim", "viewer");
      const writer = await workspace().open(dana, { memberships: acmeAdmin });
      await writer.writeFile(`/orgs/acme/apps/${app}/app.vendo`, "page: team");
      await writer.commit();

      const granted = await workspace().open(kim, { memberships: acme });
      expect(await granted.readFile(`/orgs/acme/apps/${app}/app.vendo`)).toBe("page: team");

      // A member of the org with NO grant on the app does not see the subtree.
      const ungranted = await workspace().open({ kind: "user", subject: "sam" }, { memberships: acme });
      expect(await ungranted.exists(`/orgs/acme/apps/${app}/app.vendo`)).toBe(false);
      expect(await ungranted.readdir("/orgs/acme")).not.toContain("apps");
    });

    it("refuses an org-app write from a viewer at commit, against live rows", async () => {
      const app = "app_orgwrite";
      await appStore(made.store).put({ kind: "user", subject: "acme" }, appFixture(app));
      const admin = ctxOf(dana, acmeAdmin);
      await appAccess(made.store).grant(admin, app, "user:kim", "viewer");
      const seed = await workspace().open(dana, { memberships: acmeAdmin });
      await seed.writeFile(`/orgs/acme/apps/${app}/app.vendo`, "page: v1");
      await seed.commit();

      const viewer = await workspace().open(kim, { memberships: acme });
      await viewer.writeFile(`/orgs/acme/apps/${app}/app.vendo`, "page: mine");
      await expect(viewer.commit()).rejects.toMatchObject({ code: "forbidden" });
      // The store still holds what the editor wrote.
      const after = await workspace().open(kim, { memberships: acme });
      expect(await after.readFile(`/orgs/acme/apps/${app}/app.vendo`)).toBe("page: v1");
    });

    it("reserves /orgs/<org>/policy.json writes for org admins", async () => {
      const member = await workspace().open(kim, { memberships: acme });
      await member.writeFile("/orgs/acme/policy.json", "{}");
      await expect(member.commit()).rejects.toMatchObject({ code: "forbidden" });

      const admin = await workspace().open(dana, { memberships: acmeAdmin });
      await admin.writeFile("/orgs/acme/policy.json", '{"format":"vendo/org-policy@1","rules":[]}');
      expect((await admin.commit()).status).toBe("ok");
      // ...and every member can READ it (lane H's guard composition does).
      const reader = await workspace().open(kim, { memberships: acme });
      expect(await reader.readFile("/orgs/acme/policy.json")).toContain("org-policy@1");
    });

    it("reads the history of an ORG file, owner derived from the path", async () => {
      // §9.7 — owner derivation is a pure function of the path in EVERY door.
      // Deriving it from the principal instead made a promoted app's history
      // unreachable: history() answered [].
      const path = "/orgs/acme/files/roadmap.md";
      const first = await workspace().open(dana, { memberships: acme });
      await first.writeFile(path, "v1");
      await first.commit();
      const second = await workspace().open(kim, { memberships: acme });
      await second.writeFile(path, "v2");
      await second.commit();

      expect(await workspace().history(ctxOf(kim, acme), path)).toHaveLength(1);
      const settled = await workspace().open(kim, { memberships: acme });
      expect(await settled.readFile(path)).toBe("v2");
    });

    it("refuses history on an org the host did not assert", async () => {
      // §9.4 — the failing predicate here IS the viewer check, so the answer is
      // the one a path that does not exist gets. `forbidden` would have told a
      // stranger that `/orgs/acme` is a real place with something in it.
      const path = "/orgs/acme/files/private.md";
      const seed = await workspace().open(dana, { memberships: acme });
      await seed.writeFile(path, "team only");
      await seed.commit();

      const stranger = { principal: kim, venue: "app" as const, presence: "present" as const, sessionId: "s" };
      await expect(workspace().history(stranger, path)).rejects.toMatchObject({ code: "not-found" });
    });

    describe("§9.4 — `forbidden` implies the caller is at least a viewer", () => {
      it("answers a VIEWER denied an edit with forbidden, and still reads", async () => {
        // The fork offer renders off this code, so it must keep meaning exactly
        // "you can see it, but not do this to it".
        const app = "app_orgviewerdoors";
        await appStore(made.store).put({ kind: "user", subject: "acme" }, appFixture(app));
        await appAccess(made.store).grant(ctxOf(dana, acmeAdmin), app, "user:kim", "viewer");
        const path = `/orgs/acme/apps/${app}/app.vendo`;
        const seed = await workspace().open(dana, { memberships: acmeAdmin });
        await seed.writeFile(path, "page: v1");
        await seed.commit();

        const viewer = await workspace().open(kim, { memberships: acme });
        await viewer.writeFile(path, "page: mine");
        await expect(viewer.commit()).rejects.toMatchObject({ code: "forbidden" });
        // ...and the viewer-level door lets them through.
        expect(await workspace().history(ctxOf(kim, acme), path)).toHaveLength(0);
      });

      it("answers a NON-viewer with not-found at both doors, inside an asserted org", async () => {
        // The org mount is asserted, so EACCES does not fire — the only thing
        // standing between sam and the app subtree is the grant she does not
        // hold. `forbidden` there is an existence oracle for every app id.
        const app = "app_orgmasked";
        await appStore(made.store).put({ kind: "user", subject: "acme" }, appFixture(app));
        const path = `/orgs/acme/apps/${app}/app.vendo`;
        const seed = await workspace().open(dana, { memberships: acmeAdmin });
        await seed.writeFile(path, "page: v1");
        await seed.commit();

        const sam = { kind: "user" as const, subject: "sam" };
        await expect(workspace().history(ctxOf(sam, acme), path)).rejects.toMatchObject({ code: "not-found" });
        const outsider = await workspace().open(sam, { memberships: acme });
        await outsider.writeFile(path, "page: mine");
        await expect(outsider.commit()).rejects.toMatchObject({ code: "not-found" });
      });
    });

    it("keeps an org's scratch out of the store, exactly like /user/scratch", async () => {
      const fs = await workspace().open(dana, { memberships: acme });
      await fs.writeFile("/orgs/acme/scratch/tmp.json", "{}");
      await fs.writeFile("/user/scratch/tmp.json", "{}");
      await fs.writeFile("/orgs/acme/files/kept.md", "kept");
      expect(await fs.commit()).toEqual({ status: "ok", changed: ["/orgs/acme/files/kept.md"] });
      expect(await made.sql(
        "SELECT path FROM vendo_workspace_files WHERE path LIKE '%/scratch/%'",
      )).toEqual([]);
    });

    it("refuses an org app's subtree ROOT as a file, so the namespace cannot be poisoned", async () => {
      // Without the app grant governing the bare `/orgs/<org>/apps/<id>` path,
      // any member could write it AS A FILE and the real app subtree could
      // never exist underneath it (a file cannot also be a directory).
      // §9.4 — kim holds no grant on `app_squatted` (there is no such app), so
      // the refusal wears the masked code rather than confirming the namespace.
      const squatter = await workspace().open(kim, { memberships: acme });
      await squatter.writeFile("/orgs/acme/apps/app_squatted", "mine now");
      await expect(squatter.commit()).rejects.toMatchObject({ code: "not-found" });
    });

    describe("commit policy per mount (§9.7)", () => {
      it("/orgs is strict CAS: two concurrent commits, one ok and one conflict", async () => {
        const path = "/orgs/acme/files/shared.md";
        const seed = await workspace().open(dana, { memberships: acme });
        await seed.writeFile(path, "base");
        await seed.commit();

        // Both turns opened against the SAME revision.
        const first = await workspace().open(dana, { memberships: acme });
        const second = await workspace().open(kim, { memberships: acme });
        await first.writeFile(path, "dana's edit");
        await second.writeFile(path, "kim's edit");

        expect(await first.commit()).toEqual({ status: "ok", changed: [path] });
        // Nothing throws — the loser gets the frozen conflict branch back and
        // the harness re-reads and re-applies.
        expect(await second.commit()).toEqual({ status: "conflict", paths: [path] });

        const settled = await workspace().open(dana, { memberships: acme });
        expect(await settled.readFile(path)).toBe("dana's edit");
      });

      it("/user stays last-write-wins: the second commit lands, never conflicts", async () => {
        const path = "/user/memory/notes.md";
        const seed = await workspace().open(dana);
        await seed.writeFile(path, "base");
        await seed.commit();

        const first = await workspace().open(dana);
        const second = await workspace().open(dana);
        await first.writeFile(path, "first");
        await second.writeFile(path, "second");
        expect((await first.commit()).status).toBe("ok");
        expect((await second.commit()).status).toBe("ok");

        const settled = await workspace().open(dana);
        expect(await settled.readFile(path)).toBe("second");
      });

      it("a mixed commit reports only the org paths that lost", async () => {
        const orgPath = "/orgs/acme/files/mixed.md";
        const userPath = "/user/memory/mixed.md";
        const seed = await workspace().open(dana, { memberships: acme });
        await seed.writeFile(orgPath, "base");
        await seed.commit();

        const mine = await workspace().open(dana, { memberships: acme });
        const theirs = await workspace().open(kim, { memberships: acme });
        await theirs.writeFile(orgPath, "kim wins");
        await theirs.commit();

        await mine.writeFile(orgPath, "dana loses");
        await mine.writeFile(userPath, "dana's own");
        expect(await mine.commit()).toEqual({ status: "conflict", paths: [orgPath] });
        // The /user half is unaffected by an org conflict — it is a different
        // mount with a different policy.
        const settled = await workspace().open(dana, { memberships: acme });
        expect(await settled.readFile(userPath)).toBe("dana's own");
      });
    });

    describe("the sandbox checkout/commit helpers (wave-2 lane E consumes these)", () => {
      it("answers the visible file set for a ctx, with per-path writability", async () => {
        const app = "app_checkout";
        await appStore(made.store).put({ kind: "user", subject: "acme" }, appFixture(app));
        const admin = ctxOf(dana, acmeAdmin);
        await appAccess(made.store).grant(admin, app, "user:kim", "viewer");
        const writer = await workspace().open(dana, { memberships: acmeAdmin });
        await writer.writeFile(`/orgs/acme/apps/${app}/app.vendo`, "page: co");
        await writer.writeFile("/orgs/acme/files/shared-co.md", "co");
        await writer.commit();
        const own = await workspace().open(kim);
        await own.writeFile("/user/memory/kim.md", "mine");
        await own.commit();

        const visible = await workspace().visibleFiles(ctxOf(kim, acme));
        const byPath = Object.fromEntries(visible.map((file) => [file.path, file.writable]));
        expect(byPath["/user/memory/kim.md"]).toBe(true);
        expect(byPath["/orgs/acme/files/shared-co.md"]).toBe(true);
        // Viewer on the app ⇒ the file is visible, read-only.
        expect(byPath[`/orgs/acme/apps/${app}/app.vendo`]).toBe(false);
      });

      it("answers a per-path commit check against live rows", async () => {
        const app = "app_cancommit";
        await appStore(made.store).put({ kind: "user", subject: "acme" }, appFixture(app));
        const admin = ctxOf(dana, acmeAdmin);
        await appAccess(made.store).grant(admin, app, "user:kim", "editor");
        const path = `/orgs/acme/apps/${app}/app.vendo`;

        expect(await workspace().canCommit(ctxOf(kim, acme), path)).toBe(true);
        // A mid-session revoke bites at the NEXT write, against live rows.
        await appAccess(made.store).revoke(admin, app, "user:kim");
        expect(await workspace().canCommit(ctxOf(kim, acme), path)).toBe(false);
      });
    });
  });
}
