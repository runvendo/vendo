import { VendoError, type AccessLevel, type Membership, type RunContext } from "@vendoai/core";
import { appAccessConformance, memoryStoreAdapter } from "@vendoai/core/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appAccess } from "../src/helpers/app-access.js";
import { appStore } from "../src/helpers/apps.js";
import { appFixture } from "../src/fixtures.test-util.js";
import { backends, type MadeBackend } from "../src/backends.test-util.js";
import type { VendoStore } from "../src/store.js";

/** Build contract §9.2–§9.4 — grants are the only rows Vendo stores, and
    `can()` is the one function every door reaches. */

const doc = appFixture;

const ctxFor = (subject: string, memberships?: Membership[]): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `s_${subject}`,
  ...(memberships === undefined ? {} : { memberships }),
});

for (const backend of backends()) {
  describe(`${backend.name} build contract §9 — app access`, () => {
    let made: MadeBackend;

    beforeAll(async () => {
      made = await backend.make();
      await made.store.ensureSchema();
    });
    afterAll(async () => { if (made) await made.cleanup(); });

    const access = (): ReturnType<typeof appAccess> => appAccess(made.store);

    it("gives the row's subject owner without any grant row", async () => {
      const app = "app_owned";
      await appStore(made.store).put({ kind: "user", subject: "dana" }, doc(app));
      expect(await access().levelFor(ctxFor("dana"), app)).toBe("owner");
      expect(await access().can(ctxFor("dana"), "owner", { app })).toBe(true);
      // A stranger sees nothing at all.
      expect(await access().levelFor(ctxFor("mal"), app)).toBeNull();
      expect(await access().can(ctxFor("mal"), "viewer", { app })).toBe(false);
    });

    it("makes an org admin an implicit owner of an org-owned app", async () => {
      const app = "app_org_admin";
      await appStore(made.store).put({ kind: "user", subject: "acme" }, doc(app));
      const admin = ctxFor("dana", [{ org: "acme", admin: true }]);
      const member = ctxFor("kim", [{ org: "acme" }]);
      expect(await access().levelFor(admin, app)).toBe("owner");
      // Membership alone is NOT access — the grant rows decide.
      expect(await access().levelFor(member, app)).toBeNull();
    });

    it("resolves user / team / org grants against the asserted memberships", async () => {
      const app = "app_grants";
      await appStore(made.store).put({ kind: "user", subject: "acme" }, doc(app));
      const owner = ctxFor("dana", [{ org: "acme", admin: true }]);
      await access().grant(owner, app, "user:kim", "viewer");
      await access().grant(owner, app, "team:acme/finance", "editor");
      await access().grant(owner, app, "org:acme", "viewer");

      // Direct user grant.
      expect(await access().levelFor(ctxFor("kim"), app)).toBe("viewer");
      // Effective access is the MAX of the matching grants: kim in finance is
      // an editor through the team even though her own row says viewer.
      expect(await access().levelFor(
        ctxFor("kim", [{ org: "acme", teams: ["finance"] }]),
        app,
      )).toBe("editor");
      // Org-wide grant reaches any asserted member.
      expect(await access().levelFor(ctxFor("sam", [{ org: "acme" }]), app)).toBe("viewer");
      // A team grant in a DIFFERENT org never matches.
      expect(await access().levelFor(
        ctxFor("sam", [{ org: "other", teams: ["finance"] }]),
        app,
      )).toBeNull();
    });

    it("re-granting one principal updates the level in place", async () => {
      // Held by the ORG — sharing a personal app with a person is refused
      // outright ("share implies promote"), so the live grant cases all run on
      // an app that has already moved.
      const app = "app_regrant";
      await appStore(made.store).put({ kind: "user", subject: "acme" }, doc(app));
      const owner = ctxFor("dana", [{ org: "acme", admin: true }]);
      await access().grant(owner, app, "user:kim", "viewer");
      await access().grant(owner, app, "user:kim", "editor");
      const rows = await access().list(owner, app);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.level).toBe("editor");
      expect(rows[0]?.createdBy).toBe("dana");
      expect(await access().levelFor(ctxFor("kim"), app)).toBe("editor");
    });

    it("revoke removes the grant and access with it", async () => {
      const app = "app_revoke";
      await appStore(made.store).put({ kind: "user", subject: "acme" }, doc(app));
      const owner = ctxFor("dana", [{ org: "acme", admin: true }]);
      await access().grant(owner, app, "user:kim", "editor");
      expect(await access().can(ctxFor("kim"), "editor", { app })).toBe(true);
      await access().revoke(owner, app, "user:kim");
      expect(await access().levelFor(ctxFor("kim"), app)).toBeNull();
      expect(await access().list(owner, app)).toEqual([]);
    });

    // §9.4 posture, and the red half of the permission gate: these MUST fail.
    it("refuses grant/revoke to a non-owner and list to a non-viewer", async () => {
      const app = "app_posture";
      await appStore(made.store).put({ kind: "user", subject: "acme" }, doc(app));
      await access().grant(ctxFor("dana", [{ org: "acme", admin: true }]), app, "user:kim", "editor");

      // An editor provably SEES the app, so denial is `forbidden`.
      await expect(access().grant(ctxFor("kim"), app, "user:mal", "viewer"))
        .rejects.toMatchObject({ code: "forbidden" });
      await expect(access().revoke(ctxFor("kim"), app, "user:mal"))
        .rejects.toMatchObject({ code: "forbidden" });
      // A stranger cannot even see it — existence stays masked.
      await expect(access().grant(ctxFor("mal"), app, "user:mal", "owner"))
        .rejects.toMatchObject({ code: "not-found" });
      await expect(access().list(ctxFor("mal"), app))
        .rejects.toMatchObject({ code: "not-found" });
      // ...and a viewer may read the grant list.
      expect(await access().list(ctxFor("kim"), app)).toHaveLength(1);
    });

    it("refuses an unknown grant principal encoding AT THE DOOR, before any store sees it", async () => {
      // The grammar guard used to live ONLY in the local engine's routing layer
      // (`parseAppGrantData`), so the very same share was refused on Postgres
      // and accepted on the hosted store — Cloud's own default. Which store is
      // wired may never change behaviour (the adapter rule), so `grant` refuses
      // itself, before it writes. The DOOR's sentence is what proves whose
      // refusal this is; the routing layer keeps its own as a floor.
      const app = "app_encoding";
      await appStore(made.store).put({ kind: "user", subject: "dana" }, doc(app));
      await expect(access().grant(ctxFor("dana"), app, "kim", "viewer"))
        .rejects.toThrow(/is not a principal/);
      await expect(access().grant(ctxFor("dana"), app, "group:x", "viewer"))
        .rejects.toThrow(/is not a principal/);
      await expect(access().grant(ctxFor("dana"), app, "team:acme", "viewer"))
        .rejects.toBeInstanceOf(VendoError);
      expect((await made.store.records("vendo_app_grants").list({ refs: { app_id: app } })).records)
        .toEqual([]);
    });

    it("refuses a level outside the closed vocabulary, and writes nothing", async () => {
      // The wire route that used to reject an off-vocabulary level before the
      // store ever saw one is gone with the Share dialog, so this floor is now
      // the ONLY thing standing between a typo and a row `can()` cannot rank.
      const app = "app_level_vocab";
      await appStore(made.store).put({ kind: "user", subject: "acme" }, doc(app));
      const owner = ctxFor("dana", [{ org: "acme", admin: true }]);
      await expect(access().grant(owner, app, "user:kim", "admin" as AccessLevel))
        .rejects.toThrow(/viewer, editor, or owner/);
      expect((await made.store.records("vendo_app_grants").list({ refs: { app_id: app } })).records)
        .toEqual([]);
    });

    it("resolves EVERY grant on an app, past the page size", async () => {
      // One page was all `can()` ever read, so on a heavily shared app the
      // grants beyond it silently granted nothing: somebody's access vanished
      // with no revoke, no audit row, and no row anywhere to see it in.
      const app = "app_many";
      await appStore(made.store).put({ kind: "user", subject: "dana" }, doc(app));
      const owner = ctxFor("dana");
      const grants = made.store.records("vendo_app_grants");
      const total = 505;
      for (let index = 0; index < total; index += 1) {
        await grants.put({
          id: `ag_many_${String(index).padStart(4, "0")}`,
          data: { appId: app, orgId: "dana", principal: `user:member_${index}`, level: "viewer", createdBy: "dana" },
        });
      }

      const listed = await access().list(owner, app);
      expect(listed).toHaveLength(total);
      expect(new Set(listed.map((row) => row.principal)).size).toBe(total);
    }, 60_000);

    it("refuses a grant naming an org the app does not live in", async () => {
      // §9.2's `org_id` is "the org whose workspace holds the app", so a
      // `team:`/`org:` principal from a DIFFERENT org can never be satisfied
      // honestly — accepting the row would show access that is not real.
      const app = "app_crossorg";
      await appStore(made.store).put({ kind: "user", subject: "acme" }, doc(app));
      const admin = ctxFor("dana", [{ org: "acme", admin: true }, { org: "other" }]);
      await expect(access().grant(admin, app, "org:other", "owner"))
        .rejects.toMatchObject({ code: "validation" });
      await expect(access().grant(admin, app, "team:other/finance", "editor"))
        .rejects.toMatchObject({ code: "validation" });
      expect(await access().list(admin, app)).toEqual([]);
      expect(await access().levelFor(
        ctxFor("sam", [{ org: "other", teams: ["finance"] }]),
        app,
      )).toBeNull();
    });

    it("refuses a PERSON grant on a still-personal app — the grantee would open an empty directory", async () => {
      // Design spec §8, "live sharing implies the org workspace", ruled to apply
      // to EVERY principal: a `user:` grant on a personal app used to resolve to
      // a real level, and then the grantee's agent found nothing — the app's
      // documents live under the holder's `/user` mount, and no `/user` path is
      // ever another person's. Sharing has to move the app first.
      const app = "app_personal_person";
      await appStore(made.store).put({ kind: "user", subject: "dana" }, doc(app));
      await expect(access().grant(ctxFor("dana"), app, "user:kim", "viewer"))
        .rejects.toMatchObject({ code: "validation" });
      expect(await access().levelFor(ctxFor("kim"), app)).toBeNull();
    });

    it("still lets the promoter mint their OWN owner grant before the row flips (§9.5)", async () => {
      // Promote writes `user:<promoter>` while the row is still personal, so
      // the check above must not lock the promoter out of their own app.
      const app = "app_promoter_selfgrant";
      await appStore(made.store).put({ kind: "user", subject: "dana" }, doc(app));
      await access().grant(ctxFor("dana"), app, "user:dana", "owner");
      expect(await access().list(ctxFor("dana"), app)).toHaveLength(1);
    });

    it("lets an org app be shared with a person — that is the whole point of promote", async () => {
      const app = "app_org_person";
      await appStore(made.store).put({ kind: "user", subject: "acme" }, doc(app));
      const admin = ctxFor("dana", [{ org: "acme", admin: true }]);
      await access().grant(admin, app, "user:kim", "editor");
      expect(await access().levelFor(ctxFor("kim"), app)).toBe("editor");
    });

    it("refuses a whole-team grant on a still-personal app", async () => {
      // "Share implies promote": the app has to move into the org first, and
      // the refusal says so rather than storing a grant nothing can match.
      const app = "app_personal_team";
      await appStore(made.store).put({ kind: "user", subject: "dana" }, doc(app));
      await expect(access().grant(ctxFor("dana", [{ org: "acme" }]), app, "org:acme", "viewer"))
        .rejects.toMatchObject({ code: "validation" });
    });

    // The SHARED rule (core's conformance kit), mounted against the real
    // implementation. @vendoai/apps mounts the same cases against its own
    // stand-in, so the two cannot drift: a mutation here fails there too.
    describe("core's app-access conformance kit", () => {
      const suite = appAccessConformance({
        get access() { return appAccess(made.store); },
        seedApp: async (appId, subject) => {
          await appStore(made.store).put({ kind: "user", subject }, doc(appId));
        },
        seedGrant: async (appId, principal, level) => {
          await made.store.records("vendo_app_grants").put({
            id: `ag_${appId}_${principal}`,
            data: { appId, orgId: "conformance-org", principal, level, createdBy: "seed" },
          });
        },
      });
      for (const conformanceCase of suite.cases) it(conformanceCase.name, conformanceCase.run);
    });

    describe("path access (§9.3)", () => {
      it("governs the app subtree ROOT, not only what is under it", async () => {
        const app = "app_root";
        await appStore(made.store).put({ kind: "user", subject: "acme" }, doc(app));
        const member = ctxFor("kim", [{ org: "acme" }]);
        // No grant on the app ⇒ the bare subtree path is not theirs to write,
        // so the namespace the real app needs cannot be squatted as a file.
        expect(await access().can(member, "editor", { path: `/orgs/acme/apps/${app}` })).toBe(false);
        expect(await access().can(member, "editor", { path: "/orgs/acme/apps/app_never" })).toBe(false);
      });

      it("keeps /user/** the caller's own, at every level", async () => {
        const ctx = ctxFor("dana");
        expect(await access().can(ctx, "owner", { path: "/user/apps/app_1/app.vendo" })).toBe(true);
        expect(await access().can(ctx, "viewer", { path: "/user/memory/notes.md" })).toBe(true);
      });

      it("requires an asserted membership for /orgs/<org>/**", async () => {
        const member = ctxFor("dana", [{ org: "acme" }]);
        expect(await access().can(member, "editor", { path: "/orgs/acme/files/x" })).toBe(true);
        expect(await access().can(ctxFor("dana"), "viewer", { path: "/orgs/acme/files/x" })).toBe(false);
        expect(await access().can(member, "viewer", { path: "/orgs/other/files/x" })).toBe(false);
      });

      it("lets the app grant govern under /orgs/<org>/apps/<appId>/", async () => {
        const app = "app_pathed";
        await appStore(made.store).put({ kind: "user", subject: "acme" }, doc(app));
        const owner = ctxFor("dana", [{ org: "acme", admin: true }]);
        await access().grant(owner, app, "user:kim", "viewer");
        const viewer = ctxFor("kim", [{ org: "acme" }]);
        const path = `/orgs/acme/apps/${app}/app.vendo`;
        expect(await access().can(viewer, "viewer", { path })).toBe(true);
        expect(await access().can(viewer, "editor", { path })).toBe(false);
        // A member with no grant on the app cannot see the app's subtree at all.
        expect(await access().can(ctxFor("sam", [{ org: "acme" }]), "viewer", { path })).toBe(false);
      });

      it("reserves /orgs/<org>/policy.json writes for org admins", async () => {
        const path = "/orgs/acme/policy.json";
        const admin = ctxFor("dana", [{ org: "acme", admin: true }]);
        const member = ctxFor("kim", [{ org: "acme" }]);
        expect(await access().can(member, "viewer", { path })).toBe(true);
        expect(await access().can(member, "editor", { path })).toBe(false);
        expect(await access().can(admin, "editor", { path })).toBe(true);
      });

      it("refuses a path outside the frozen mounts", async () => {
        expect(await access().can(ctxFor("dana"), "viewer", { path: "/etc/passwd" })).toBe(false);
        expect(await access().can(ctxFor("dana"), "viewer", { path: "/orgs" })).toBe(false);
      });
    });
  });
}

/**
 * §9.2's one-row-per-(app, principal) rule, proven on a records adapter that is
 * NOT the local Postgres engine.
 *
 * The rule was enforced only by `ON CONFLICT (app_id, principal)` in
 * `routing.ts` — a constraint this door never sees. Every multi-party
 * deployment runs on a hosted or BYO records adapter, which is keyed by id
 * alone, exactly as core's reference adapter is. This is the same failure class
 * `app-access.ts` already documents one paragraph up: a rule enforced only in
 * the local engine behaved differently on Cloud.
 */
describe("build contract §9.2 — grants over a generic records adapter", () => {
  const app = "app_shared";
  const owner = ctxFor("dana", [{ org: "acme", admin: true }]);

  const madeStore = async (): Promise<ReturnType<typeof appAccess>> => {
    const adapter = memoryStoreAdapter();
    await adapter.ensureSchema();
    const store = adapter as unknown as VendoStore;
    await store.records("vendo_apps").put({
      id: app,
      data: { subject: "acme", enabled: true, doc: doc(app) },
    });
    return appAccess(store);
  };

  it("re-granting a principal updates the one row rather than accreting a second", async () => {
    const access = await madeStore();
    await access.grant(owner, app, "user:kim", "viewer");
    await access.grant(owner, app, "user:kim", "editor");

    const rows = await access.list(owner, app);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.level).toBe("editor");
  });

  it("downgrades a principal, instead of folding the old level back in", async () => {
    const access = await madeStore();
    await access.grant(owner, app, "user:kim", "editor");
    await access.grant(owner, app, "user:kim", "viewer");

    // Two rows make `levelFor` fold them with `strongerLevel`, so the downgrade
    // silently does nothing and kim keeps editor forever.
    expect(await access.levelFor(ctxFor("kim", [{ org: "acme" }]), app)).toBe("viewer");
  });

  it("keeps one row when two grants for the same principal overlap, so a later downgrade sticks", async () => {
    const access = await madeStore();
    // Two owners share with kim in the same instant. `grant` reads the app's
    // grants, finds no row for kim, and only THEN writes — so both reads land
    // before either write and an id minted on that empty read is a DIFFERENT id
    // per caller. Two rows for one principal is the unrevokable grant this
    // whole describe exists to prevent: `levelFor` folds them with
    // `strongerLevel`, so the downgrade below updates one row and the other
    // keeps editor standing. Nothing here is a stub — the interleave is the
    // real reference adapter's own await points.
    await Promise.all([
      access.grant(owner, app, "user:kim", "editor"),
      access.grant(owner, app, "user:kim", "editor"),
    ]);
    expect(await access.list(owner, app)).toHaveLength(1);

    await access.grant(owner, app, "user:kim", "viewer");
    expect(await access.levelFor(ctxFor("kim", [{ org: "acme" }]), app)).toBe("viewer");
  });

  it("revokes every row for the principal, so access cannot survive a revoke", async () => {
    const access = await madeStore();
    await access.grant(owner, app, "user:kim", "viewer");
    await access.grant(owner, app, "user:kim", "editor");

    await access.revoke(owner, app, "user:kim");

    expect(await access.list(owner, app)).toHaveLength(0);
    expect(await access.levelFor(ctxFor("kim", [{ org: "acme" }]), app)).toBeNull();
  });
});
