import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Membership,
  type Principal,
  type ToolRegistry,
} from "@vendoai/core";
import { createStore, createStoreOps, type VendoStore } from "@vendoai/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

/**
 * SHARE IMPLIES PROMOTE, over the real composition — a real PGlite store, the
 * real `createVendo`, the real wire route the ✦ toggle calls. Nothing is
 * stubbed on either side, because the whole claim is that the grant write and
 * the workspace move agree, and two mocks can never disagree.
 *
 * Every path that creates an app stamps it with the PERSON (build-surface.ts,
 * seed-surface.ts, apps-surface.ts, interchange.ts), and core refuses to grant
 * an org access to a still-personal app (ruled 2026-08-01, pinned at
 * conformance/app-access.ts:181-201): the app's documents live under the
 * holder's own `/user` mount, so a share that skipped the move would hand the
 * recipient an empty app. So the toggle MOVES the app first.
 *
 * THE ONE THAT MUST BE ABLE TO FAIL is the last case. The move restamps the
 * row's subject as the org id, so the ownership fast path
 * (doors/access-checks.ts:65) stops matching the person who did it — and in a
 * host where she is not a tenant ADMIN, that is her losing the app she just
 * shared. Her own owner grant is minted BEFORE the flip for exactly that
 * reason (helpers/app-access.ts:186-188). Mint it after, or not at all, and
 * "the promoter keeps her app" goes red.
 */

const ORG = "maple";
const dana: Principal = { kind: "user", subject: "dana" };
/** Kim is an ORDINARY member — no `admin` flag. That is the whole point: in
 *  Maple only the primary user is admin, so she is the person the ordering
 *  protects. */
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
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-share-promotes-"));
  const store = createStore({ dataDir });
  // The very ops surface compose would build over this store anyway
  // (compose-store.ts:118-120 takes `store.ops` when there is one), held here so
  // a test can watch whether `lifecycle.promote` ran.
  store.ops = createStoreOps(store);
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** Whose request this is — set per call, the way a real session would. */
let acting: Principal = kim;

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
    headers: {
      origin: "https://maple.test",
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

/** A PERSONAL app — the only kind any create path produces. */
const seedPersonalApp = async (store: VendoStore, app: AppDocument, subject: string): Promise<void> => {
  await store.records("vendo_apps").put({
    id: app.id,
    data: { subject, enabled: false, doc: app },
    refs: { subject },
  });
};

const subjectOf = async (store: VendoStore, appId: string): Promise<unknown> =>
  (await store.records("vendo_apps").get(appId))?.refs?.["subject"];

describe("the ✦ share toggle's write, over the real composition", () => {
  let store: VendoStore;
  let vendo: Vendo;

  beforeEach(async () => {
    store = await tempStore();
    vi.stubEnv("VENDO_API_KEY", "vnd_share_key");
    vendo = createVendo({
      store,
      auth: {
        principal: async () => acting,
        memberships: async (principal) => memberships[principal.subject] ?? [],
      },
    });
    vendo.actions.add(tools);
    await store.ensureSchema();
  });

  it("moves the app into the tenant, then grants — a personal app cannot just be shared", async () => {
    await seedPersonalApp(store, seeded("app_kim", "Kim's tracker"), "kim");
    expect(await subjectOf(store, "app_kim")).toBe("kim");

    const shared = await call(vendo, kim, "PUT", `/apps/app_kim/grants/${encodeURIComponent(`org:${ORG}`)}`, {
      level: "viewer",
    });
    expect(shared.status).toBe(200);

    // The move HAPPENED — this is what makes the grant meaningful instead of a
    // pointer at an empty `/user` mount.
    expect(await subjectOf(store, "app_kim")).toBe(ORG);
    expect(shared.body.grants.map((row: { principal: string; level: string }) => [row.principal, row.level]))
      .toContainEqual([`org:${ORG}`, "viewer"]);
  });

  it("refuses a tenant the sharer does not belong to, and moves nothing", async () => {
    await seedPersonalApp(store, seeded("app_stranger", "Kim's tracker"), "kim");
    const promote = vi.spyOn(store.ops!.lifecycle, "promote");

    // Kim owns this app outright, so the owner gate lets her through. `acme` is
    // somebody else's workspace — she is a member of Maple and nowhere else.
    const refused = await call(vendo, kim, "PUT", `/apps/app_stranger/grants/${encodeURIComponent("org:acme")}`, {
      level: "viewer",
    });

    expect(refused.status).toBe(403);
    expect(promote).not.toHaveBeenCalled();
    // Nothing moved and nothing was written — not even the owner row the flip is
    // preceded by. Her app is still hers, and acme's admins never saw it.
    expect(await subjectOf(store, "app_stranger")).toBe("kim");
    expect((await call(vendo, kim, "GET", "/apps/app_stranger/grants")).body.grants).toEqual([]);
  });

  it("the promoter KEEPS her app — she is an ordinary member, not a tenant admin", async () => {
    await seedPersonalApp(store, seeded("app_keep", "Kim's tracker"), "kim");

    expect((await call(vendo, kim, "PUT", `/apps/app_keep/grants/${encodeURIComponent(`org:${ORG}`)}`, {
      level: "viewer",
    })).status).toBe(200);
    expect(await subjectOf(store, "app_keep")).toBe(ORG);

    // Her ownership fast path is gone (the row's subject is the ORG now), and
    // she holds no admin membership — so the ONLY thing that can still answer
    // "owner" is the grant minted before the flip.
    const read = await call(vendo, kim, "GET", "/apps/app_keep/grants");
    expect(read.status).toBe(200);
    expect(read.body.level).toBe("owner");
    // Not merely visible — still hers to edit and to share again.
    expect((await call(vendo, kim, "GET", "/apps/app_keep")).status).toBe(200);
    expect((await call(vendo, kim, "DELETE", `/apps/app_keep/grants/${encodeURIComponent(`org:${ORG}`)}`)).status)
      .toBe(200);
  });

  it("the tenant's admin reaches it once it has moved, and a stranger stays masked", async () => {
    await seedPersonalApp(store, seeded("app_reach", "Kim's tracker"), "kim");
    // Dana is the org's admin but the app is Kim's, so it is not hers yet.
    expect((await call(vendo, dana, "GET", "/apps/app_reach")).status).toBe(404);

    await call(vendo, kim, "PUT", `/apps/app_reach/grants/${encodeURIComponent(`org:${ORG}`)}`, { level: "viewer" });

    expect((await call(vendo, dana, "GET", "/apps/app_reach")).status).toBe(200);
    expect((await call(vendo, { kind: "user", subject: "stranger" }, "GET", "/apps/app_reach")).status).toBe(404);
  });

  it("un-sharing revokes and does NOT move the app back", async () => {
    await seedPersonalApp(store, seeded("app_back", "Kim's tracker"), "kim");
    await call(vendo, kim, "PUT", `/apps/app_back/grants/${encodeURIComponent(`org:${ORG}`)}`, { level: "viewer" });

    const revoked = await call(vendo, kim, "DELETE", `/apps/app_back/grants/${encodeURIComponent(`org:${ORG}`)}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.grants.map((row: { principal: string }) => row.principal)).not.toContain(`org:${ORG}`);
    // There is no demote, deliberately: the app's documents live in the
    // tenant's workspace now, and moving them back is its own decision.
    expect(await subjectOf(store, "app_back")).toBe(ORG);
    expect((await call(vendo, kim, "GET", "/apps/app_back")).status).toBe(200);
  });
});
