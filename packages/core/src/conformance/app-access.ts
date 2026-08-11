import type { AccessLevel, AppAccess } from "../app-access.js";
import type { AppId } from "../ids.js";
import type { Membership, RunContext } from "../run-context.js";
import { assert } from "./assertions.js";
import type { ConformanceCase, ConformanceSuite } from "./index.js";

/**
 * Build contract §9.2–§9.4 — the executable definition of `can()`.
 *
 * There are two implementations of this seam: `appAccess(store)` in
 * @vendoai/store, and the stand-in @vendoai/apps' own tests run against a
 * memory store (the runtime cannot import the store — `apps → core` is the only
 * edge layering allows it). Two implementations of one rule is exactly how a
 * permission check rots: mutate the real `can()` to `return true` and the
 * stand-in's suite stays green.
 *
 * So the RULE lives here, once, and both implementations mount it. A case that
 * fails is a divergence, whichever side moved.
 */

export interface AppAccessConformanceOptions {
  /** The implementation under test, over whatever store the caller wired. */
  access: AppAccess;
  /** Put an app row whose subject is `subject` (a person, or an org id). */
  seedApp(appId: AppId, subject: string): Promise<void>;
  /** Put a grant row directly, WITHOUT the owner gate — these cases set the
      world up; the gate itself is asserted through `access.grant`. */
  seedGrant(appId: AppId, principal: string, level: AccessLevel): Promise<void>;
}

const ctxFor = (subject: string, memberships?: Membership[]): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `s_${subject}`,
  ...(memberships === undefined ? {} : { memberships }),
});

const ORG = "conformance-org";
const OTHER = "conformance-other";

export function appAccessConformance(options: AppAccessConformanceOptions): ConformanceSuite {
  const { seedApp, seedGrant } = options;
  // Read lazily on every use: a suite is usually built before the store it will
  // run against exists (a vitest `beforeAll`), so `options.access` may be a getter.
  const access = { get it() { return options.access; } };
  /** Fresh ids per case, so a suite can run twice against one store. */
  let counter = 0;
  const nextId = (): AppId => `app_conf_${Date.now().toString(36)}_${counter++}` as AppId;

  const cases: ConformanceCase[] = [
    {
      name: "the row's subject is owner, and a stranger sees nothing",
      async run() {
        const appId = nextId();
        await seedApp(appId, "dana");
        assert(await access.it.levelFor(ctxFor("dana"), appId) === "owner", "the owner is not owner");
        assert(await access.it.can(ctxFor("dana"), "owner", { app: appId }), "the owner cannot own");
        assert(await access.it.levelFor(ctxFor("mal"), appId) === null, "a stranger has a level");
        assert(!(await access.it.can(ctxFor("mal"), "viewer", { app: appId })), "a stranger can view");
      },
    },
    {
      name: "an unknown app is null, never a level",
      async run() {
        assert(await access.it.levelFor(ctxFor("dana"), nextId()) === null, "an absent app has a level");
      },
    },
    {
      name: "membership alone is not access; an org ADMIN is an implicit owner",
      async run() {
        const appId = nextId();
        await seedApp(appId, ORG);
        assert(
          await access.it.levelFor(ctxFor("kim", [{ org: ORG }]), appId) === null,
          "a plain member has access with no grant",
        );
        assert(
          await access.it.levelFor(ctxFor("dana", [{ org: ORG, admin: true }]), appId) === "owner",
          "an org admin is not an implicit owner",
        );
      },
    },
    {
      name: "effective access is the MAX of the matching grants",
      async run() {
        const appId = nextId();
        await seedApp(appId, ORG);
        await seedGrant(appId, "user:kim", "viewer");
        await seedGrant(appId, `team:${ORG}/finance`, "editor");
        assert(await access.it.levelFor(ctxFor("kim"), appId) === "viewer", "the user grant does not apply");
        assert(
          await access.it.levelFor(ctxFor("kim", [{ org: ORG, teams: ["finance"] }]), appId) === "editor",
          "the stronger team grant does not win",
        );
      },
    },
    {
      name: "an org-wide grant reaches any ASSERTED member and nobody else",
      async run() {
        const appId = nextId();
        await seedApp(appId, ORG);
        await seedGrant(appId, `org:${ORG}`, "viewer");
        assert(
          await access.it.levelFor(ctxFor("sam", [{ org: ORG }]), appId) === "viewer",
          "an asserted member misses the org grant",
        );
        assert(
          await access.it.levelFor(ctxFor("sam"), appId) === null,
          "the org grant applied with nothing asserted",
        );
      },
    },
    {
      name: "a team grant in another org never matches",
      async run() {
        const appId = nextId();
        await seedApp(appId, ORG);
        await seedGrant(appId, `team:${ORG}/finance`, "editor");
        assert(
          await access.it.levelFor(ctxFor("sam", [{ org: OTHER, teams: ["finance"] }]), appId) === null,
          "a same-named team in another org matched",
        );
      },
    },
    {
      name: "a level the caller does not hold is refused",
      async run() {
        const appId = nextId();
        await seedApp(appId, ORG);
        await seedGrant(appId, "user:kim", "viewer");
        const kim = ctxFor("kim");
        assert(await access.it.can(kim, "viewer", { app: appId }), "a viewer cannot view");
        assert(!(await access.it.can(kim, "editor", { app: appId })), "a viewer can edit");
        assert(!(await access.it.can(kim, "owner", { app: appId })), "a viewer can own");
      },
    },
    {
      name: "grant is owner-gated; a viewer is forbidden and a stranger masked",
      async run() {
        const appId = nextId();
        await seedApp(appId, "dana");
        await seedGrant(appId, "user:kim", "viewer");
        let refused: unknown;
        await access.it.grant(ctxFor("kim"), appId, "user:mal", "viewer").catch((error) => { refused = error; });
        assert((refused as { code?: string })?.code === "forbidden", "a viewer's grant was not forbidden");
        let masked: unknown;
        await access.it.grant(ctxFor("mal"), appId, "user:mal", "owner").catch((error) => { masked = error; });
        assert((masked as { code?: string })?.code === "not-found", "a stranger's grant was not masked");
      },
    },
    {
      name: "list is viewer-gated and masked from a non-viewer",
      async run() {
        const appId = nextId();
        await seedApp(appId, "dana");
        await seedGrant(appId, "user:kim", "viewer");
        assert((await access.it.list(ctxFor("kim"), appId)).length === 1, "a viewer cannot read the grant list");
        let masked: unknown;
        await access.it.list(ctxFor("mal"), appId).catch((error) => { masked = error; });
        assert((masked as { code?: string })?.code === "not-found", "a stranger read the grant list");
      },
    },
    {
      name: "the owner's grant → revoke round trip changes real access",
      async run() {
        // Held by the ORG: sharing implies the org workspace, so a live grant to
        // another person only exists on an app that has already moved (below).
        const appId = nextId();
        await seedApp(appId, ORG);
        const owner = ctxFor("dana", [{ org: ORG, admin: true }]);
        await access.it.grant(owner, appId, "user:kim", "editor");
        assert(await access.it.levelFor(ctxFor("kim"), appId) === "editor", "the grant did not land");
        await access.it.grant(owner, appId, "user:kim", "viewer");
        assert((await access.it.list(owner, appId)).length === 1, "re-granting accreted a row");
        assert(await access.it.levelFor(ctxFor("kim"), appId) === "viewer", "re-granting did not update the level");
        await access.it.revoke(owner, appId, "user:kim");
        assert(await access.it.levelFor(ctxFor("kim"), appId) === null, "revoke left access behind");
      },
    },
    {
      name: "a PERSON grant on a still-personal app is refused — share implies promote",
      async run() {
        // Design spec §8: "Live sharing implies the org workspace", ruled
        // 2026-08-01 to hold for EVERY principal. Without this, the grant
        // resolved and the grantee's agent then opened an empty directory: the
        // app's documents live under the holder's `/user` mount, and no `/user`
        // path is ever another person's.
        const appId = nextId();
        await seedApp(appId, "dana");
        let refused: unknown;
        await access.it.grant(ctxFor("dana"), appId, "user:kim", "viewer")
          .catch((error) => { refused = error; });
        assert((refused as { code?: string })?.code === "validation", "a personal person-share was accepted");
        assert(await access.it.levelFor(ctxFor("kim"), appId) === null, "the personal person-share landed anyway");
        // The promoter's OWN row is the exception: promote mints it before the
        // row flips, so the person handing the app over is not locked out.
        await access.it.grant(ctxFor("dana"), appId, "user:dana", "owner");
        assert((await access.it.list(ctxFor("dana"), appId)).length === 1, "the promoter's own grant was refused");
      },
    },
    {
      name: "a principal outside the §9.2 grammar is refused by the DOOR, whatever store is under it",
      async run() {
        // The guard lived in ONE store's SQL, so the same share was refused on
        // Postgres and accepted on the hosted store (Cloud's own default). An
        // unparseable principal cannot be matched by `grantMatches` either, so
        // accepting one wrote a row that granted nobody anything.
        const appId = nextId();
        await seedApp(appId, ORG);
        const admin = ctxFor("dana", [{ org: ORG, admin: true }]);
        for (const bad of ["kim", "group:x", "team:justanorg", "user:", "org:a/b"]) {
          let refused: unknown;
          await access.it.grant(admin, appId, bad, "viewer").catch((error) => { refused = error; });
          assert((refused as { code?: string })?.code === "validation", `"${bad}" was accepted as a principal`);
        }
        assert((await access.it.list(admin, appId)).length === 0, "an unparseable principal was stored");
      },
    },
    {
      name: "a grant naming an org the app does not live in is refused",
      async run() {
        const appId = nextId();
        await seedApp(appId, ORG);
        const admin = ctxFor("dana", [{ org: ORG, admin: true }, { org: OTHER }]);
        let refused: unknown;
        await access.it.grant(admin, appId, `org:${OTHER}`, "owner").catch((error) => { refused = error; });
        assert((refused as { code?: string })?.code === "validation", "a cross-org grant was accepted");
        assert(
          await access.it.levelFor(ctxFor("sam", [{ org: OTHER }]), appId) === null,
          "the cross-org grant landed anyway",
        );
      },
    },
    {
      name: "/user/** is the caller's own at every level",
      async run() {
        const dana = ctxFor("dana");
        assert(await access.it.can(dana, "owner", { path: "/user/apps/app_x/app.vendo" }), "own /user is not owned");
        assert(await access.it.can(dana, "viewer", { path: "/user/memory/notes.md" }), "own /user is not readable");
      },
    },
    {
      name: "/orgs/<org>/** needs an asserted membership in THAT org",
      async run() {
        const path = `/orgs/${ORG}/files/x.md`;
        assert(await access.it.can(ctxFor("dana", [{ org: ORG }]), "editor", { path }), "a member cannot write");
        assert(!(await access.it.can(ctxFor("dana"), "viewer", { path })), "a non-member can read");
        assert(
          !(await access.it.can(ctxFor("dana", [{ org: OTHER }]), "viewer", { path })),
          "another org's membership granted access",
        );
      },
    },
    {
      name: "an org app's subtree is governed by the app grant, root included",
      async run() {
        const appId = nextId();
        await seedApp(appId, ORG);
        await seedGrant(appId, "user:kim", "viewer");
        const inside = `/orgs/${ORG}/apps/${appId}/app.vendo`;
        const root = `/orgs/${ORG}/apps/${appId}`;
        const kim = ctxFor("kim", [{ org: ORG }]);
        assert(await access.it.can(kim, "viewer", { path: inside }), "a viewer cannot read the subtree");
        assert(!(await access.it.can(kim, "editor", { path: inside })), "a viewer can write the subtree");
        const sam = ctxFor("sam", [{ org: ORG }]);
        assert(!(await access.it.can(sam, "viewer", { path: inside })), "an ungranted member sees the subtree");
        assert(!(await access.it.can(sam, "editor", { path: root })), "an ungranted member can squat the root");
      },
    },
    {
      name: "/orgs/<org>/policy.json is readable by members, writable by admins",
      async run() {
        const path = `/orgs/${ORG}/policy.json`;
        const member = ctxFor("kim", [{ org: ORG }]);
        assert(await access.it.can(member, "viewer", { path }), "a member cannot read the policy");
        assert(!(await access.it.can(member, "editor", { path })), "a member can rewrite the policy");
        assert(
          await access.it.can(ctxFor("dana", [{ org: ORG, admin: true }]), "editor", { path }),
          "an admin cannot rewrite the policy",
        );
      },
    },
    {
      name: "a path outside the frozen mounts is refused",
      async run() {
        const dana = ctxFor("dana", [{ org: ORG }]);
        assert(!(await access.it.can(dana, "viewer", { path: "/etc/passwd" })), "an outside path was allowed");
        assert(!(await access.it.can(dana, "viewer", { path: "/orgs" })), "the bare /orgs root was allowed");
      },
    },
  ];

  return { seam: "app-access (build contract §9.2–§9.4)", cases };
}
