import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  type AccessLevel,
  type AppDocument,
  type Membership,
  type Principal,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { appAccess, createStore, createStoreOps, workspaceStore, type VendoStore } from "@vendoai/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

/**
 * Multi-party orgs over the REAL composition: `createVendo` fills `appAccess`
 * and the memberships seam itself, and every assertion below goes through the
 * actual wire routes a browser calls.
 *
 * Grant ROWS are fixture, written through the same `appAccess(store)` seam the
 * composition wires into the runtime — the Share dialog's own wire routes are
 * gone, and what these tests are about is what every OTHER door does with a
 * grant that exists.
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
  opts: { key?: boolean } = {},
): Promise<Vendo> {
  // The key fills Cloud defaults for the adapter slots this composition leaves
  // unset; `key: false` is how §9.6 boots a keyless deployment over the very
  // same store, because enforcement may never be key-conditional.
  if (opts.key !== false) vi.stubEnv("VENDO_API_KEY", "vnd_orgs_key");
  const vendo = createVendo({
    store,
    auth: {
      principal: async () => acting,
      memberships: async (principal) => memberships[principal.subject] ?? [],
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

/** A request context for the grant seam, carrying the same memberships the
    host asserts on the wire — `can()` reads them from the ctx and nowhere else. */
const ctxFor = (principal: Principal): RunContext => ({
  principal,
  venue: "app",
  presence: "present",
  sessionId: `s_${principal.subject}`,
  memberships: memberships[principal.subject] ?? [],
});

const share = (store: VendoStore, who: Principal, appId: string, principal: string, level: AccessLevel) =>
  appAccess(store).grant(ctxFor(who), appId, principal, level);

describe("two principals, one org, over the real composition", () => {
  let store: VendoStore;
  let vendo: Vendo;

  beforeEach(async () => {
    store = await tempStore();
    vendo = await boot(store);
  });

  it("one org app, two people: the granted member sees the SAME app, not a copy", async () => {
    await seedApp(store, seeded("app_dash", "Team dashboard"), ORG);

    // Kim is an ordinary member, so the org app is masked until she is granted.
    expect((await call(vendo, kim, "GET", "/apps")).body).toEqual([]);
    // Dana is the org's admin, so she is its apps' implicit owner (§9.3).
    expect((await call(vendo, dana, "GET", "/apps")).body.map((app: AppDocument) => app.id))
      .toEqual(["app_dash"]);

    await share(store, dana, "app_dash", "user:kim", "viewer");
    expect((await call(vendo, kim, "GET", "/apps")).body.map((app: AppDocument) => app.id))
      .toEqual(["app_dash"]);
    // The SAME app id — not a copy.
    expect((await call(vendo, kim, "GET", "/apps/app_dash")).body.name).toBe("Team dashboard");
  });

  it("a viewer may read the team's app versions, and a stranger may not", async () => {
    // The level belongs in the runtime, not only in this route, which is why
    // the runtime takes the ctx.
    await seedApp(store, seeded("app_hist", "Shared"), ORG);
    await share(store, dana, "app_hist", "user:kim", "viewer");

    const listed = await call(vendo, kim, "GET", "/apps/app_hist/history");
    expect(listed.status).toBe(200);

    // A caller who cannot see it stays masked.
    const stranger: Principal = { kind: "user", subject: "stranger" };
    expect((await call(vendo, stranger, "GET", "/apps/app_hist/history")).status).toBe(404);
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

  it("a viewer denied an edit gets forbidden (403) and can fork", async () => {
    await seedApp(store, seeded("app_view", "Shared view"), ORG);
    await share(store, dana, "app_view", "user:kim", "viewer");

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
    await share(store, dana, "app_rev", "user:kim", "editor");
    expect((await call(vendo, kim, "GET", "/apps/app_rev")).status).toBe(200);

    await appAccess(store).revoke(ctxFor(dana), "app_rev", "user:kim");

    // The app is masked again, and a write is refused against live rows.
    expect((await call(vendo, kim, "GET", "/apps/app_rev")).status).toBe(404);
    // A workspace commit is the other live-rows door (§9.7): a session that
    // already checked out keeps what it read, but cannot land a write.
    const workspace = workspaceStore(store);
    const path = `/orgs/${ORG}/apps/app_rev/app.tsx`;
    expect(await workspace.canCommit({ principal: kim, memberships: memberships["kim"] }, path)).toBe(false);
    expect(await workspace.canCommit({ principal: dana, memberships: memberships["dana"] }, path)).toBe(true);
  });

  it("per-user app data inside a shared org app stays subject-partitioned", async () => {
    await seedApp(store, seeded("app_data", "Shared with private state"), ORG);
    await share(store, dana, "app_data", "user:kim", "editor");

    // The owner rides in the appData target — sharing the app changes nothing
    // about that, which is exactly why per-user data needs no new machinery.
    const rows = createStoreOps(store).appData;
    const drawer = (owner: string) => ({ appId: "app_data", collection: "drafts", owner });
    await rows.put(drawer("dana"), { id: "draft_dana", data: { draft: "dana's numbers" } });
    await rows.put(drawer("kim"), { id: "draft_kim", data: { draft: "kim's numbers" } });

    expect((await rows.get(drawer("dana"), "draft_dana"))?.data).toEqual({ draft: "dana's numbers" });
    expect((await rows.get(drawer("kim"), "draft_kim"))?.data).toEqual({ draft: "kim's numbers" });
    // Kim is an editor on the shared app and still cannot reach Dana's row.
    expect(await rows.get(drawer("kim"), "draft_dana")).toBeNull();
    expect((await rows.list(drawer("dana"))).records.map((row) => row.id)).toEqual(["draft_dana"]);
    expect((await rows.list(drawer("kim"))).records.map((row) => row.id)).toEqual(["draft_kim"]);
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

  it("the memberships seam is asserted per request and never stored", async () => {
    await seedApp(store, seeded("app_asserted", "Asserted"), ORG);
    await share(store, dana, "app_asserted", `org:${ORG}`, "viewer");
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

describe("§9.6: enforcement is never key-conditional", () => {
  it("resolves an existing grant identically with no key at all", async () => {
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

    const access = appAccess(store);
    expect(await access.levelFor(ctxFor(kim), "app_keyless")).toBe("viewer");
    expect((await call(vendo, kim, "GET", "/apps/app_keyless")).status).toBe(200);
    // Reading the grant list stays OSS too.
    expect(await access.list(ctxFor(kim), "app_keyless")).toHaveLength(1);
  });
});
