import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Membership,
  type Principal,
  type ResolvedPerson,
  type ToolRegistry,
} from "@vendoai/core";
import { appAccess, createStore, workspaceStore, type VendoStore } from "@vendoai/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "./server.js";

/**
 * Multi-party orgs over the REAL composition: `createVendo` fills `appAccess`,
 * `multiParty`, `promoteApp` and the memberships seam itself, and every
 * assertion below goes through the actual wire routes a browser calls.
 *
 * Two real people in one org: Dana (org admin) and Kim (ordinary member).
 * Seeded apps only — new-app GENERATION against a host catalog is a known
 * engine failure (#631), which these tests deliberately do not depend on.
 */

const ORG = "maple";
const dana: Principal = { kind: "user", subject: "dana" };
const kim: Principal = { kind: "user", subject: "kim" };

const memberships: Record<string, Membership[]> = {
  dana: [{ org: ORG, display: "Maple Bank", teams: ["support"], admin: true }],
  kim: [{ org: ORG, display: "Maple Bank", teams: ["support"] }],
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no host tools" } }; },
};

const seeded = (id: string, name: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name,
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-orgs-multi-party-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** Whose request this is — set per call, the way a real session would. */
let acting: Principal = dana;

async function boot(
  store: VendoStore,
  opts: { key?: boolean; resolvePerson?: (query: string, asker: Principal) => Promise<ResolvedPerson | null> } = {},
): Promise<Vendo> {
  // §9.6 — multiParty is filled from the SAME cloud-key read every other Cloud
  // default uses, so this env stub is the whole difference between keyed and
  // keyless. Nothing else in the composition changes.
  if (opts.key !== false) vi.stubEnv("VENDO_API_KEY", "vnd_orgs_key");
  const vendo = createVendo({
    store,
    auth: {
      principal: async () => acting,
      memberships: async (principal) => memberships[principal.subject] ?? [],
      ...(opts.resolvePerson === undefined ? {} : { resolvePerson: opts.resolvePerson }),
    },
  });
  // Wave-2's §10 config consolidation narrowed `tools:` to the host's own
  // ExtractedTool[] declarations; a live registry arrives through the actions
  // door (integration, 2026-08-01 — same migration the rest of the suite made).
  vendo.actions.add(tools);
  await store.ensureSchema();
  return vendo;
}

const BASE = "https://maple.test/api/vendo";

async function call(
  vendo: Vendo,
  who: Principal,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  acting = who;
  const response = await vendo.handler(new Request(`${BASE}${path}`, {
    method,
    // The wire's CSRF floor requires application/json on every mutation (a
    // simple credentialed form POST must not reach a route), body or not.
    headers: {
      origin: "https://maple.test",
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

const seedApp = async (store: VendoStore, app: AppDocument, subject: string): Promise<void> => {
  await store.records("vendo_apps").put({
    id: app.id,
    data: { subject, enabled: false, doc: app },
    refs: { subject },
  });
};

describe("two principals, one org, over the real composition", () => {
  let store: VendoStore;
  let vendo: Vendo;

  beforeEach(async () => {
    store = await tempStore();
    vendo = await boot(store);
  });

  it("promote → both see ONE living app", async () => {
    await seedApp(store, seeded("app_dash", "Team dashboard"), "dana");

    // Kim cannot see Dana's personal app at all.
    expect((await call(vendo, kim, "GET", "/apps")).body).toEqual([]);

    expect((await call(vendo, dana, "POST", "/apps/app_dash/promote", { orgId: ORG })).status).toBe(200);
    // The row now belongs to the org, verbatim.
    expect((await store.records("vendo_apps").get("app_dash"))?.refs?.["subject"]).toBe(ORG);

    // Dana still reaches it (the owner grant promote minted), and Kim reaches it
    // as an ordinary member once she is granted — one app, two people.
    expect((await call(vendo, dana, "GET", "/apps")).body.map((app: AppDocument) => app.id))
      .toEqual(["app_dash"]);
    await call(vendo, dana, "POST", "/apps/app_dash/grants", { principal: "user:kim", level: "viewer" });
    expect((await call(vendo, kim, "GET", "/apps")).body.map((app: AppDocument) => app.id))
      .toEqual(["app_dash"]);
    // The SAME app id — not a copy.
    expect((await call(vendo, kim, "GET", "/apps/app_dash")).body.name).toBe("Team dashboard");
  });

  it("a viewer cannot roll the team's app back, but may read its versions", async () => {
    // `undo` is an EDIT of the shared app — the level belongs in the runtime,
    // not only in this route, which is why the runtime now takes the ctx.
    await seedApp(store, seeded("app_undo", "Shared"), ORG);
    await call(vendo, dana, "POST", "/apps/app_undo/grants", { principal: "user:kim", level: "viewer" });

    const listed = await call(vendo, kim, "GET", "/apps/app_undo/history");
    expect(listed.status).toBe(200);

    const rolled = await call(vendo, kim, "POST", "/apps/app_undo/history", { op: "undo" });
    expect(rolled.status).toBe(403);
    expect(rolled.body.error.code).toBe("forbidden");

    // A caller who cannot see it stays masked at both verbs.
    const stranger: Principal = { kind: "user", subject: "stranger" };
    expect((await call(vendo, stranger, "GET", "/apps/app_undo/history")).status).toBe(404);
    expect((await call(vendo, stranger, "POST", "/apps/app_undo/history", { op: "undo" })).status).toBe(404);
  });

  it("the harness workspace door mounts the asserted orgs", async () => {
    // The /orgs mounts have to be reachable from a PRODUCTION door, not only by
    // calling the store directly: the harness door resolves the same host
    // memberships seam the wire does, keyed on the principal.
    const fs = await vendo.harness.workspace(kim);
    expect(await fs.readdir("/")).toEqual(["host", "orgs", "user"]);
    expect(await fs.readdir("/orgs")).toEqual([ORG]);
    await fs.writeFile(`/orgs/${ORG}/files/from-the-door.md`, "hello");
    expect(await fs.commit()).toEqual({ status: "ok", changed: [`/orgs/${ORG}/files/from-the-door.md`] });

    // A principal the host asserts nothing for keeps today's single-player
    // façade — the mount set is the assertions, nothing else.
    const solo = await vendo.harness.workspace({ kind: "user", subject: "stranger" });
    expect(await solo.readdir("/")).toEqual(["host", "user"]);
  });

  it("removing your OWN last grant succeeds honestly — the work landed, so say so", async () => {
    // The route read the grant list back to build its answer, and reading it is
    // viewer-gated: a caller who just removed their own last grant got a 404 for
    // a removal that had already happened, which the Share dialog renders as an
    // error. A mutation that landed must never report failure.
    await seedApp(store, seeded("app_selfrevoke", "Kim's own"), "kim");
    expect((await call(vendo, kim, "POST", "/apps/app_selfrevoke/promote", { orgId: ORG })).status).toBe(200);

    const removed = await call(vendo, kim, "DELETE", "/apps/app_selfrevoke/grants?principal=user%3Akim");
    expect(removed.status).toBe(200);
    // An empty list is the honest answer: it is what she can still legitimately
    // see, not a fabricated list of who else reaches the app.
    expect(removed.body.grants).toEqual([]);
    // The removal really landed, and she really did give up her access.
    expect((await store.records("vendo_app_grants").list({ refs: { app_id: "app_selfrevoke" } })).records)
      .toEqual([]);
    expect((await call(vendo, kim, "GET", "/apps/app_selfrevoke")).status).toBe(404);
  });

  it("a stranger's DELETE is masked and mutates NOTHING", async () => {
    await seedApp(store, seeded("app_strangerdel", "Team app"), ORG);
    await call(vendo, dana, "POST", "/apps/app_strangerdel/grants", { principal: "user:kim", level: "viewer" });

    const stranger: Principal = { kind: "user", subject: "stranger" };
    const refused = await call(vendo, stranger, "DELETE", "/apps/app_strangerdel/grants?principal=user%3Akim");
    expect(refused.status).toBe(404);
    expect(refused.body.error.code).toBe("not-found");
    // The refusal happens at the owner gate, BEFORE the delete.
    expect((await store.records("vendo_app_grants").list({ refs: { app_id: "app_strangerdel" } })).records)
      .toHaveLength(1);
    expect((await call(vendo, kim, "GET", "/apps/app_strangerdel")).status).toBe(200);
  });

  it("two simultaneous promotes: one wins, and the LOSER undoes nothing of the winner's", async () => {
    // The dangerous shape is not the collision — it is the rollback. A promote
    // that loses the row flip must not reverse the document move the winner made
    // or revoke the grant the winner minted: doing either leaves the owner with
    // a half-moved app she can no longer see (row in the org, documents back
    // under /user, no grant to admit her).
    await seedApp(store, seeded("app_race", "Race"), "dana");
    const workspace = workspaceStore(store);
    const mine = await workspace.open(dana);
    await mine.writeFile("/user/apps/app_race/app.vendo", "page: v1");
    await mine.commit();

    const both = await Promise.all([
      call(vendo, dana, "POST", "/apps/app_race/promote", { orgId: ORG }),
      call(vendo, dana, "POST", "/apps/app_race/promote", { orgId: ORG }),
    ]);
    // At least one succeeds, and nothing 5xxes — a lost race is a `conflict`
    // (409) or, if the loser starts after the winner finished, simply the app
    // already in its org (200). Never a crash, never a raw database error.
    expect(both.some((answer) => answer.status === 200)).toBe(true);
    expect(both.every((answer) => answer.status < 500)).toBe(true);

    // THE INVARIANT, whatever the interleaving was: one living app, wholly in
    // the org, and its owner still reaches it.
    expect((await store.records("vendo_apps").get("app_race"))?.refs?.["subject"]).toBe(ORG);
    const rows = await (store.raw() as {
      query(sql: string, params: unknown[]): Promise<{ rows: Array<{ path: string; owner: string }> }>;
    }).query("SELECT path, owner FROM vendo_workspace_files WHERE path LIKE $1 ORDER BY path", ["%app_race%"]);
    expect(rows.rows).toEqual([
      { path: `/orgs/${ORG}/apps/app_race/app.vendo`, owner: ORG },
    ]);
    const grants = await call(vendo, dana, "GET", "/apps/app_race/grants");
    expect(grants.body.level).toBe("owner");
    expect(grants.body.grants.map((grant: { principal: string; level: string }) => grant))
      .toEqual([expect.objectContaining({ principal: "user:dana", level: "owner" })]);
    expect((await call(vendo, dana, "GET", "/apps/app_race")).status).toBe(200);
  });

  it("refuses a colliding promote in the consumer's voice, leaving the app WHOLLY personal", async () => {
    // The org workspace already holds documents at this app's subtree. Promote
    // is all-or-nothing: the documents move first and the row flips last, so a
    // refusal here leaves nothing half-moved.
    await seedApp(store, seeded("app_collide", "Mine"), "dana");
    const workspace = workspaceStore(store);
    const mine = await workspace.open(dana);
    await mine.writeFile("/user/apps/app_collide/app.vendo", "page: mine");
    await mine.commit();
    await (store.raw() as { query(sql: string, params: unknown[]): Promise<unknown> }).query(
      "INSERT INTO vendo_workspace_files (path, owner, content, bytes) VALUES ($1, $2, $3, $4)",
      [`/orgs/${ORG}/apps/app_collide/app.vendo`, ORG, "someone else's", 14],
    );

    const refused = await call(vendo, dana, "POST", "/apps/app_collide/promote", { orgId: ORG });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("conflict");
    // A typed refusal in the consumer's voice — never a raw database error.
    expect(refused.body.error.message).not.toMatch(/duplicate key|constraint|SQLSTATE/i);

    // The app is still entirely Dana's: row AND documents.
    expect((await store.records("vendo_apps").get("app_collide"))?.refs?.["subject"]).toBe("dana");
    const rows = await (store.raw() as {
      query(sql: string, params: unknown[]): Promise<{ rows: Array<{ path: string; owner: string }> }>;
    }).query("SELECT path, owner FROM vendo_workspace_files WHERE path LIKE $1 ORDER BY path", ["%app_collide%"]);
    expect(rows.rows).toEqual([
      { path: `/orgs/${ORG}/apps/app_collide/app.vendo`, owner: ORG },
      { path: "/user/apps/app_collide/app.vendo", owner: "dana" },
    ]);
    // ...and its grant set too: the owner grant a promote mints goes back with
    // the documents, so a refused promote leaves nothing behind at all.
    expect((await call(vendo, dana, "GET", "/apps/app_collide/grants")).body).toEqual({
      level: "owner",
      grants: [],
      personal: true,
    });
  });

  it("a viewer denied an edit gets forbidden (403) and can fork", async () => {
    await seedApp(store, seeded("app_view", "Shared view"), ORG);
    await call(vendo, dana, "POST", "/apps/app_view/grants", { principal: "user:kim", level: "viewer" });

    const denied = await call(vendo, kim, "POST", "/apps/app_view/edit", { instruction: "make it blue" });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("forbidden");

    // ...and the offer behind that code works: her own copy, in her workspace.
    const forked = await call(vendo, kim, "POST", "/apps/app_view/fork");
    expect(forked.status).toBe(200);
    expect(forked.body.forkedFrom).toBe("app_view");
    expect((await store.records("vendo_apps").get(forked.body.id))?.refs?.["subject"]).toBe("kim");
    // Grants never travel: nothing points at the copy.
    expect((await store.records("vendo_app_grants").list({ refs: { app_id: forked.body.id } })).records)
      .toEqual([]);

    // A caller with NO access at all stays masked — never 403.
    acting = { kind: "user", subject: "stranger" };
    const masked = await call(vendo, { kind: "user", subject: "stranger" }, "POST", "/apps/app_view/edit", {
      instruction: "make it blue",
    });
    expect(masked.status).toBe(404);
  });

  it("revoke → reads age, the next write fails against LIVE rows", async () => {
    await seedApp(store, seeded("app_rev", "Revocable"), ORG);
    await call(vendo, dana, "POST", "/apps/app_rev/grants", { principal: "user:kim", level: "editor" });
    expect((await call(vendo, kim, "GET", "/apps/app_rev")).status).toBe(200);

    const revoked = await call(vendo, dana, "DELETE", "/apps/app_rev/grants?principal=user%3Akim");
    expect(revoked.status).toBe(200);

    // The app is masked again, and a write is refused against live rows.
    expect((await call(vendo, kim, "GET", "/apps/app_rev")).status).toBe(404);
    // A workspace commit is the other live-rows door (§9.7): a session that
    // already checked out keeps what it read, but cannot land a write.
    const workspace = workspaceStore(store);
    const path = `/orgs/${ORG}/apps/app_rev/app.vendo`;
    expect(await workspace.canCommit({ principal: kim, memberships: memberships["kim"] }, path)).toBe(false);
    expect(await workspace.canCommit({ principal: dana, memberships: memberships["dana"] }, path)).toBe(true);
  });

  it("per-user app data inside a promoted app stays subject-partitioned", async () => {
    await seedApp(store, seeded("app_data", "Shared with private state"), ORG);
    await call(vendo, dana, "POST", "/apps/app_data/grants", { principal: "user:kim", level: "editor" });

    // App storage is keyed (appId, subject) — promotion changes nothing about
    // that, which is exactly why per-user data needs no new machinery.
    const state = store.records("vendo_state");
    await state.put({ id: "app_data:dana", data: { draft: "dana's numbers" } });
    await state.put({ id: "app_data:kim", data: { draft: "kim's numbers" } });

    expect((await state.get("app_data:dana"))?.data).toEqual({ draft: "dana's numbers" });
    expect((await state.get("app_data:kim"))?.data).toEqual({ draft: "kim's numbers" });
    const rows = await state.list({ refs: { app_id: "app_data" } });
    expect(rows.records.map((row) => row.id).sort()).toEqual(["app_data:dana", "app_data:kim"]);
  });

  it("two concurrent /orgs commits to one file: one ok, one conflict (E3's org slice)", async () => {
    const workspace = workspaceStore(store);
    const path = `/orgs/${ORG}/files/handbook.md`;
    const seed = await workspace.open(dana, { memberships: memberships["dana"] });
    await seed.writeFile(path, "v1");
    await seed.commit();

    const mine = await workspace.open(dana, { memberships: memberships["dana"] });
    const theirs = await workspace.open(kim, { memberships: memberships["kim"] });
    await mine.writeFile(path, "dana's v2");
    await theirs.writeFile(path, "kim's v2");

    expect(await mine.commit()).toEqual({ status: "ok", changed: [path] });
    expect(await theirs.commit()).toEqual({ status: "conflict", paths: [path] });
  });

  it("refuses a level outside the closed vocabulary, and a missing principal", async () => {
    await seedApp(store, seeded("app_vocab", "Vocabulary"), ORG);
    // §9.3's level vocabulary is CLOSED: `operator` and friends are explicitly
    // out of scope, so a typo (or an invented level) is refused at the door
    // rather than landing a row `can()` cannot rank.
    const bad = await call(vendo, dana, "POST", "/apps/app_vocab/grants", {
      principal: "user:kim",
      level: "operator",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain("viewer, editor, or owner");

    const noPrincipal = await call(vendo, dana, "POST", "/apps/app_vocab/grants", { level: "viewer" });
    expect(noPrincipal.status).toBe(400);
    // ...and the green half: a legal level goes straight through.
    expect((await call(vendo, dana, "POST", "/apps/app_vocab/grants", {
      principal: "user:kim",
      level: "editor",
    })).status).toBe(200);
  });

  it("the memberships seam is asserted per request and never stored", async () => {
    await seedApp(store, seeded("app_asserted", "Asserted"), ORG);
    await call(vendo, dana, "POST", "/apps/app_asserted/grants", { principal: `org:${ORG}`, level: "viewer" });
    // The org-wide grant reaches Kim because the host asserts her membership.
    expect((await call(vendo, kim, "GET", "/apps/app_asserted")).status).toBe(200);

    // Stop asserting it — nothing was persisted, so access simply stops.
    const restore = memberships["kim"]!;
    memberships["kim"] = [];
    try {
      expect((await call(vendo, kim, "GET", "/apps/app_asserted")).status).toBe(404);
    } finally {
      memberships["kim"] = restore;
    }
    // ...and no Vendo table anywhere holds a membership row: the org tables the
    // pre-wave-3 design once had are gone and were deliberately not re-added
    // (§9.1 — the host's identity system IS the org).
    const tables = await (store.raw() as { query(sql: string): Promise<{ rows: Array<{ table_name: string }> }> })
      .query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    const names = tables.rows.map((row) => row.table_name);
    expect(names).not.toContain("vendo_orgs");
    expect(names).not.toContain("vendo_org_members");
    // The ONLY multi-party rows are the grants (§9.2).
    expect(names.filter((name) => name.includes("grant")).sort())
      .toEqual(["vendo_app_grants", "vendo_grants", "vendo_mcp_grants"]);
  });
});

describe("§9.8: the served-app proxy is a wire door", () => {
  let store: VendoStore;
  let vendo: Vendo;

  beforeEach(async () => {
    store = await tempStore();
    vendo = await boot(store);
  });

  it("refuses a non-viewer at the proxy BEFORE any machine work", async () => {
    // A served org app whose machine does not even exist. The access check runs
    // FIRST, so a stranger gets the mask while a granted viewer gets past the
    // door and fails on the absent machine instead. Asserting BOTH is what makes
    // this discriminating: an unmounted route would 404 everybody alike.
    await seedApp(store, { ...seeded("app_served_door", "Kanban"), ui: "http" }, ORG);
    await call(vendo, dana, "POST", "/apps/app_served_door/grants", {
      principal: "user:kim",
      level: "viewer",
    });

    const masked = await call(vendo, { kind: "user", subject: "stranger" }, "GET", "/apps/app_served_door/serve/");
    expect(masked.status).toBe(404);
    expect(masked.body.error.code).toBe("not-found");

    const admitted = await call(vendo, kim, "GET", "/apps/app_served_door/serve/");
    expect(admitted.status).not.toBe(404);
  });

  it("refuses the revoked viewer's next proxy request against live rows", async () => {
    await seedApp(store, { ...seeded("app_served_revoke", "Kanban"), ui: "http" }, ORG);
    await call(vendo, dana, "POST", "/apps/app_served_revoke/grants", {
      principal: "user:kim",
      level: "viewer",
    });
    // Granted: the door lets her through to the machine layer (which then fails
    // on the absent machine — a 4xx/5xx that is NOT the access mask).
    const granted = await call(vendo, kim, "GET", "/apps/app_served_revoke/serve/");
    expect(granted.status).not.toBe(404);

    await call(vendo, dana, "DELETE", "/apps/app_served_revoke/grants?principal=user%3Akim");
    // Revoked: the very next request is masked again, decided on live rows.
    expect((await call(vendo, kim, "GET", "/apps/app_served_revoke/serve/")).status).toBe(404);
  });

  it("admits the OWNER on the same proxy route every other caller uses", async () => {
    // There is no second path for a personal served app any more: the owner goes
    // through the very door a granted viewer does, and the check is the same
    // `can(viewer)` — it just always says yes for the person who owns the row.
    await seedApp(store, { ...seeded("app_served_own", "Mine"), ui: "http" }, "dana");
    const own = await call(vendo, dana, "GET", "/apps/app_served_own/serve/");
    // Dana owns it, so the door admits her (and the absent machine is what
    // fails) — never a permission refusal.
    expect(own.status).not.toBe(403);
    expect(own.body?.error?.code).not.toBe("not-found");
  });
});

describe("§9.8: open() hands a served app a RESOLVABLE url", () => {
  it("is absolute, so a caller off this origin can follow it", async () => {
    // An MCP client (or anything that is not a browser sitting on the host
    // origin) cannot resolve a relative path. The provider URL this replaced was
    // absolute, so the proxy URL that answers for every served app must be too.
    const store = await tempStore();
    vi.stubEnv("VENDO_BASE_URL", "https://maple.test");
    vi.stubEnv("VENDO_API_KEY", "vnd_orgs_key");
    const vendo = createVendo({
      store,
      auth: {
        principal: async () => acting,
        memberships: async (principal) => memberships[principal.subject] ?? [],
      },
    });
    vendo.actions.add(tools);
    await store.ensureSchema();
    // A served (layer-3) app the org holds. No wake happens on this path — the
    // proxy wakes the machine only after IT has re-checked access.
    await seedApp(store, {
      ...seeded("app_abs", "Kanban"),
      ui: "http",
      machine: { snapshotRef: "fakebox:none", provisionedAt: "2026-08-01T00:00:00.000Z" },
    }, ORG);
    await call(vendo, dana, "POST", "/apps/app_abs/grants", { principal: "user:kim", level: "viewer" });

    const opened = await call(vendo, kim, "GET", "/apps/app_abs/open");
    expect(opened.status).toBe(200);
    expect(opened.body).toEqual({
      kind: "http",
      url: "https://maple.test/api/vendo/apps/app_abs/serve/",
    });
  });
});

/**
 * Build contract §9.1 companion (ratified 2026-08-01) — a person-share needs the
 * HOST to name the person. The dialog used to encode what was typed VERBATIM as
 * the subject, so a share with "Mia" wrote `user:Mia` — a row that matched
 * nobody, after the app had already been moved into the team to make room for it.
 */
describe("§9.1 companion: only the host can name a person", () => {
  const roster: Record<string, ResolvedPerson> = {
    "kim": { subject: "kim", display: "Kim Alvarez" },
    "kim@maple.test": { subject: "kim", display: "Kim Alvarez" },
  };
  /** Every asker the host was handed, in order — the seam is only useful if the
      host is told WHO is asking. */
  let askers: Principal[] = [];
  beforeEach(() => { askers = []; });
  const resolvePerson = async (query: string, asker: Principal): Promise<ResolvedPerson | null> => {
    askers.push(asker);
    return roster[query.trim().toLowerCase()] ?? null;
  };

  it("says on /status that it has no directory, and refuses the lookup, when the seam is unset", async () => {
    const store = await tempStore();
    const vendo = await boot(store);
    await seedApp(store, seeded("app_nodir", "Team pulse"), ORG);

    // The surface learns from the SAME per-request answer everything else uses.
    expect((await call(vendo, dana, "GET", "/status")).body.namesPeople).toBeUndefined();
    const refused = await call(vendo, dana, "POST", "/apps/app_nodir/grants/resolve", { query: "kim" });
    expect(refused.status).toBe(501);
    // Teams and orgs are untouched by the absence.
    expect((await call(vendo, dana, "POST", "/apps/app_nodir/grants", {
      principal: `team:${ORG}/support`,
      level: "viewer",
    })).status).toBe(200);
  });

  it("resolves a typed name to the host's own subject, and writes the grant for THAT", async () => {
    const store = await tempStore();
    const vendo = await boot(store, { resolvePerson });
    await seedApp(store, seeded("app_named", "Team pulse"), ORG);

    expect((await call(vendo, dana, "GET", "/status")).body.namesPeople).toBe(true);
    const found = await call(vendo, dana, "POST", "/apps/app_named/grants/resolve", {
      query: "Kim@Maple.test",
    });
    expect(found.body).toEqual({ person: { subject: "kim", display: "Kim Alvarez" } });

    // The grant is written for the RESOLVED subject. The typed string never
    // becomes a principal.
    expect((await call(vendo, dana, "POST", "/apps/app_named/grants", {
      principal: `user:${found.body.person.subject}`,
      level: "editor",
    })).status).toBe(200);
    expect((await call(vendo, kim, "GET", "/apps/app_named")).status).toBe(200);
  });

  it("answers null for a name the host does not know, and refuses the typed string as a principal", async () => {
    const store = await tempStore();
    const vendo = await boot(store, { resolvePerson });
    await seedApp(store, seeded("app_unknown", "Team pulse"), ORG);

    const missing = await call(vendo, dana, "POST", "/apps/app_unknown/grants/resolve", { query: "Mia" });
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual({ person: null });

    // And the old behaviour — encode what was typed — is refused at the door,
    // whatever store is under it (§9.2).
    const bare = await call(vendo, dana, "POST", "/apps/app_unknown/grants", {
      principal: "Mia",
      level: "viewer",
    });
    expect(bare.status).toBe(400);
    expect((await store.records("vendo_app_grants").list({ refs: { app_id: "app_unknown" } })).records)
      .toEqual([]);
  });

  it("hands the host the ASKER, through the real composition", async () => {
    // The seam exists so a host can scope its OWN directory ("only people in the
    // asker's org"). It cannot, if it is never told who asked — and the runtime
    // thread is the half a preset-level test cannot see, because presets forward
    // the callback by reference.
    const store = await tempStore();
    const vendo = await boot(store, { resolvePerson });
    await seedApp(store, seeded("app_asker", "Team pulse"), ORG);

    expect((await call(vendo, dana, "POST", "/apps/app_asker/grants/resolve", { query: "kim" })).status)
      .toBe(200);
    expect(askers).toEqual([dana]);
  });

  it("refuses a caller in NO org before the host's directory is ever consulted", async () => {
    // The checker's attack: a signed-in user with zero memberships owns their own
    // personal app, so they are its owner — and were handed the host's real
    // subjects and display names at HTTP 200, from a share they could never
    // complete (a person-share implies an org workspace, §9.5).
    const store = await tempStore();
    const vendo = await boot(store, { resolvePerson });
    const loner: Principal = { kind: "user", subject: "loner" };
    await seedApp(store, seeded("app_loner", "Just mine"), loner.subject);

    // They really do own it — this is not a masking case.
    expect((await call(vendo, loner, "GET", "/apps/app_loner/grants")).body.level).toBe("owner");
    const probe = await call(vendo, loner, "POST", "/apps/app_loner/grants/resolve", { query: "kim" });
    expect(probe.status).toBe(403);
    expect(probe.body.error.code).toBe("forbidden");
    // The host's directory was never touched, so nothing leaked to be filtered.
    expect(askers).toEqual([]);
  });

  it("keeps the directory behind the SAME gate that writes the grant", async () => {
    // Whoever may ask "who is this person" can enumerate the host's own users.
    const store = await tempStore();
    const vendo = await boot(store, { resolvePerson });
    await seedApp(store, seeded("app_gated", "Team pulse"), ORG);
    await call(vendo, dana, "POST", "/apps/app_gated/grants", { principal: "user:kim", level: "editor" });

    // Kim is an EDITOR — she sees the app and cannot share it, so she cannot ask.
    const asEditor = await call(vendo, kim, "POST", "/apps/app_gated/grants/resolve", { query: "kim" });
    expect(asEditor.status).toBe(403);
    // A stranger is masked exactly as they are everywhere else.
    const stranger: Principal = { kind: "user", subject: "stranger" };
    expect((await call(vendo, stranger, "POST", "/apps/app_gated/grants/resolve", { query: "kim" })).status)
      .toBe(404);
  });
});

describe("§9.6: the key gates the WRITES, never the enforcement", () => {
  it("refuses grant and promote with no key, while can() answers identically", async () => {
    const store = await tempStore();
    const vendo = await boot(store, { key: false });
    await seedApp(store, seeded("app_keyless", "Keyless"), ORG);
    // A grant row written directly (as a keyed deployment would have) so the
    // comparison is "same rows, different key", which is the actual claim.
    await store.records("vendo_app_grants").put({
      id: "ag_keyless",
      data: { appId: "app_keyless", orgId: ORG, principal: "user:kim", level: "viewer", createdBy: "dana" },
      refs: { app_id: "app_keyless", principal: "user:kim", level: "viewer" },
    });

    const share = await call(vendo, dana, "POST", "/apps/app_keyless/grants", {
      principal: "user:sam",
      level: "viewer",
    });
    expect(share.status).toBe(402);
    expect(share.body.error.code).toBe("cloud-required");

    await seedApp(store, seeded("app_keyless_own", "Mine"), "dana");
    const promote = await call(vendo, dana, "POST", "/apps/app_keyless_own/promote", { orgId: ORG });
    expect(promote.status).toBe(402);

    // ...and `can()` is untouched by the key: the existing row still grants.
    const access = appAccess(store);
    const ctx = {
      principal: kim,
      venue: "app" as const,
      presence: "present" as const,
      sessionId: "s",
      memberships: memberships["kim"]!,
    };
    expect(await access.levelFor(ctx, "app_keyless")).toBe("viewer");
    expect((await call(vendo, kim, "GET", "/apps/app_keyless")).status).toBe(200);
    // Reading the grant list stays OSS too.
    expect((await call(vendo, kim, "GET", "/apps/app_keyless/grants")).body.grants).toHaveLength(1);
  });
});
