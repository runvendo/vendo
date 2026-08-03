import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Membership,
  type Principal,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { ADOPTION_VENUE_KEY } from "@vendoai/ui/chrome";
import { createStore, eraseStore, storeFiles, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "./server.js";

/**
 * F7 (wave-3 independent check) — the four INTEGRATION WIRINGS had zero
 * regression coverage, and both integration defects the wave found lived exactly
 * there. Each test below pins one composition line in `server.ts` and fails if
 * that line is removed:
 *
 *  (a) `venueState:`      — the adoption card reaches an editor's open payload
 *  (b) `onDocumentEdit:`  — a third party's edit invalidates the sponsorship
 *  (c) `appAccess:` (automations) — the fire-time can(editor) is the real one
 *  (d) `ADOPTION_VENUE_KEY` — producer and renderer name the same key
 *
 * Plus F24: the venue-state lookup is guarded, and costs nothing on an app that
 * is not an automation.
 *
 * Everything runs over the REAL composition — `createVendo` fills every seam
 * itself, exactly as a host's deployment does.
 */

const ORG = "maple";
const dana: Principal = { kind: "user", subject: "dana" };   // org admin
const kim: Principal = { kind: "user", subject: "kim" };     // editor by grant
const omar: Principal = { kind: "user", subject: "omar" };   // viewer by grant

const memberships: Record<string, Membership[]> = {
  dana: [{ org: ORG, display: "Maple Bank", teams: ["support"], admin: true }],
  kim: [{ org: ORG, display: "Maple Bank", teams: ["support"] }],
  omar: [{ org: ORG, display: "Maple Bank", teams: ["support"] }],
};

const READ_TOOL = "host_readInvoices";

const SLOT = "net-worth-card";
const BASELINE = {
  slot: SLOT,
  source: "export default function NetWorthCard() {\n  return <strong>$1.2M</strong>;\n}\n",
  hash: "sha256:maple-base",
  exportable: false,
  capturedAt: "2026-07-14T12:00:00.000Z",
  sampleProps: { valueCents: 120_000_000 },
};

/** An automation app: a v2 tree to open AND a schedule to fire. */
const automationApp = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Nightly digest",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
  trigger: {
    on: { kind: "schedule", every: "1h" },
    run: { kind: "steps", steps: [{ id: "read", tool: READ_TOOL }] },
  },
});

/** The same automation on a HOST EVENT, for the emit path. */
const eventAutomationApp = (id: string): AppDocument => ({
  ...automationApp(id),
  trigger: {
    on: { kind: "host-event", event: "invoice.paid" },
    run: { kind: "steps", steps: [{ id: "read", tool: READ_TOOL }] },
  },
});

/** A plain app: no trigger, so nothing to adopt and nothing to look up. */
const plainApp = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Spending",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
});

const ORIGIN = "https://maple.test";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

let acting: Principal = dana;

interface Booted {
  vendo: Vendo;
  store: VendoStore;
  /** Every automations-owned collection this composition opened, in order. */
  opened: string[];
}

async function boot(): Promise<Booted> {
  const root = await mkdtemp(join(tmpdir(), "vendo-wave3-"));
  await mkdir(join(root, ".vendo", "remixable"), { recursive: true });
  await writeFile(join(root, ".vendo", "remixable", `${SLOT}.json`), JSON.stringify(BASELINE));
  const store = createStore({ dataDir: join(root, "data") });
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  vi.stubEnv("VENDO_API_KEY", "vnd_wave3_key");
  const vendo = createVendo({
    store,
    profileDir: root,
    auth: {
      principal: async () => acting,
      memberships: async (principal) => memberships[principal.subject] ?? [],
    },
  });
  const tools: ToolRegistry = {
    async descriptors() {
      return [{
        name: READ_TOOL,
        description: "Read the invoices",
        inputSchema: { type: "object" },
        risk: "read",
      }];
    },
    async execute() { return { status: "ok", output: { invoices: [] } }; },
  };
  vendo.actions.add(tools);
  await store.ensureSchema();

  // Counting the automations-owned collection opens, through the SAME store
  // handle the composition holds (patched in place so the store's own identity —
  // which `dbFor` keys on — is untouched).
  const opened: string[] = [];
  const original = store.records.bind(store);
  store.records = (collection: string) => {
    if (collection.startsWith("automations:")) opened.push(collection);
    return original(collection);
  };
  return { vendo, store, opened };
}

/** A direct-call ctx asserts the caller's orgs exactly as the wire's own
 *  resolver does (§9.1) — memberships ride the ctx and are read from nowhere
 *  else, so a hand-built ctx that omits them is a caller with no orgs. */
const ctxOf = (who: Principal): RunContext => ({
  principal: who,
  venue: "app",
  presence: "present",
  sessionId: `s_${who.subject}`,
  memberships: memberships[who.subject] ?? [],
});

async function wire(
  vendo: Vendo,
  who: Principal,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  acting = who;
  const response = await vendo.handler(new Request(`${ORIGIN}/api/vendo${path}`, {
    method,
    headers: {
      origin: ORIGIN,
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
    refs: {
      subject,
      ...(app.trigger === undefined ? {} : { trigger_kind: app.trigger.on.kind }),
    },
  });
};

/** An org-owned automation, sponsored by whoever `sponsor` is, shared with an
 *  editor and a viewer. */
async function sharedAutomation(
  booted: Booted,
  id: string,
  sponsor: Principal = dana,
): Promise<AppDocument> {
  const app = automationApp(id);
  await seedApp(booted.store, app, ORG);
  expect((await wire(booted.vendo, dana, "POST", `/apps/${id}/grants`, {
    principal: "user:kim",
    level: "editor",
  })).status).toBe(200);
  expect((await wire(booted.vendo, dana, "POST", `/apps/${id}/grants`, {
    principal: "user:omar",
    level: "viewer",
  })).status).toBe(200);
  const armed = await booted.vendo.automations.enable(id, ctxOf(sponsor));
  expect(armed.enabled).toBe(true);
  return app;
}

const payloadOf = (surface: any): Record<string, unknown> => {
  expect(surface.kind).toBe("tree");
  return surface.payload as Record<string, unknown>;
};

describe("F7(a)+(d) — the adoption card reaches the app, under the key the renderer reads", () => {
  it("serves the card to an editor and not to a viewer", async () => {
    const booted = await boot();
    const app = await sharedAutomation(booted, "app_card");
    // A third party edits it: the sponsorship lapses and the ask is real.
    await booted.vendo.automations.onDocumentEdit(app, app, omar.subject);

    const editorPayload = payloadOf((await wire(booted.vendo, kim, "GET", `/apps/${app.id}/open`)).body);
    // (d) The key is the RENDERER's own constant, imported from @vendoai/ui —
    // the two halves of the composition contract, compared rather than assumed.
    expect(ADOPTION_VENUE_KEY).toBe("adoption");
    expect(editorPayload[ADOPTION_VENUE_KEY]).toMatchObject({
      appId: app.id,
      automation: "Nightly digest",
      reason: "edit",
    });

    // A viewer sees the app, not the ask (§9.9: served only to can(editor)).
    const viewerPayload = payloadOf((await wire(booted.vendo, omar, "GET", `/apps/${app.id}/open`)).body);
    expect(viewerPayload[ADOPTION_VENUE_KEY]).toBeUndefined();
  });
});

describe("F7(b) — a third party's edit through the real apps path invalidates the sponsorship", () => {
  it("invalidates when an EDITOR who is not the sponsor lands a document edit", async () => {
    const booted = await boot();
    const app = await sharedAutomation(booted, "app_hook");
    const sponsorship = async () =>
      (await booted.store.records("automations:sponsorships").get(app.id))?.data as
        { sponsor: string; status: string; reason?: string } | undefined;
    expect(await sponsorship()).toMatchObject({ sponsor: dana.subject, status: "active" });

    // The smallest MODEL-FREE write that reaches the apps runtime's persist choke
    // point: the Remix gesture's deterministic pin fork.
    acting = kim;
    const forked = await booted.vendo.apps.pins.fork({ appId: app.id, slot: SLOT }, ctxOf(kim));
    expect(forked.slot).toBe(SLOT);

    expect(await sponsorship()).toMatchObject({ status: "invalidated", reason: "edit" });
  });
});

describe("F7(c) — the automations engine's can(editor) is the real one", () => {
  it("lets an ORG app's sponsor keep firing on a grant, and stops them once it is revoked", async () => {
    const booted = await boot();
    // Kim sponsors an app she does NOT own (the row belongs to the org), so the
    // fire-time check can only pass through `appAccess`. Unwired, it falls back
    // to ownership — "maple" !== "kim" — and the very first fire would stop.
    const app = await sharedAutomation(booted, "app_seam", kim);
    const sponsorship = async () =>
      (await booted.store.records("automations:sponsorships").get(app.id))?.data as
        { sponsor: string; status: string; reason?: string } | undefined;
    expect(await sponsorship()).toMatchObject({ sponsor: kim.subject, status: "active" });

    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(await booted.vendo.automations.tick(later)).toHaveLength(1);
    expect(await sponsorship()).toMatchObject({ status: "active" });

    // Revoke the grant that authorized her, and the next fire stops the run and
    // asks for an adopter — the frozen §9.9 word for a lost permission.
    expect((await wire(booted.vendo, dana, "DELETE", `/apps/${app.id}/grants?principal=user%3Akim`)).status)
      .toBe(200);
    const later2 = new Date(Date.now() + 4 * 60 * 60 * 1000);
    expect(await booted.vendo.automations.tick(later2)).toHaveLength(1);
    expect(await sponsorship()).toMatchObject({ status: "invalidated", reason: "grants" });
  });
});

describe("F24 — the venue-state lookup is guarded, and free when there is nothing to look up", () => {
  it("costs no store read at all on an app that is not an automation", async () => {
    const booted = await boot();
    await seedApp(booted.store, plainApp("app_plain"), "dana");

    const opened = payloadOf((await wire(booted.vendo, dana, "GET", "/apps/app_plain/open")).body);
    expect(opened[ADOPTION_VENUE_KEY]).toBeUndefined();
    expect(booted.opened).toEqual([]);

    // ...while an automation app really does look, so the cheap answer above is
    // a short-circuit and not a dead seam.
    const app = await sharedAutomation(booted, "app_looked");
    booted.opened.length = 0;
    payloadOf((await wire(booted.vendo, kim, "GET", `/apps/${app.id}/open`)).body);
    expect(booted.opened).toContain("automations:sponsorships");
  });

  it("still opens the app when the adoption lookup itself fails", async () => {
    const booted = await boot();
    const app = await sharedAutomation(booted, "app_hiccup");
    const original = booted.store.records.bind(booted.store);
    booted.store.records = (collection: string) => {
      if (collection === "automations:sponsorships") {
        return { ...original(collection), get: async () => { throw new Error("store hiccup"); } } as any;
      }
      return original(collection);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const opened = payloadOf((await wire(booted.vendo, kim, "GET", `/apps/${app.id}/open`)).body);

    // The card is gone; the app is not.
    expect(opened[ADOPTION_VENUE_KEY]).toBeUndefined();
    expect(opened["root"] ?? opened["nodes"]).toBeDefined();
    expect(warn.mock.calls.flat().join(" ")).toContain("venue state");
  });
});

/** F8(b) — the erase axes this wave created, over the REAL store. Adoption is
 *  what makes "the sponsor is not the row owner" possible, and §9.7's rule is
 *  that the org outlives the person: erasing a member must take everything that
 *  was THEIRS and nothing that is the org's. */
describe("F8(b) — a member's erase against an org-owned automation", () => {
  it("takes her grant, her sponsorship and her own app — and spares the org's app and its runs", async () => {
    const booted = await boot();
    const app = await sharedAutomation(booted, "app_org_erase", kim);
    await seedApp(booted.store, plainApp("app_kim_own"), kim.subject);
    // A real fire, so there is a run row anchored to the ORG's app.
    expect(await booted.vendo.automations.tick(new Date(Date.now() + 2 * 60 * 60 * 1000))).toHaveLength(1);
    const runs = async () =>
      (await booted.store.records("vendo_runs").list({ refs: { app_id: app.id } })).records;
    expect(await runs()).toHaveLength(1);

    const report = await eraseStore(booted.store, { files: storeFiles(booted.store) })
      .bySubject(kim.subject);

    // Hers goes.
    expect(await booted.store.records("vendo_apps").get("app_kim_own")).toBeNull();
    expect(report.vendo_apps).toBe(1);
    // The sponsorship row NAMED her, so it goes with her (refs.subject) — while
    // the era marker, which names nobody, stays.
    expect(await booted.store.records("automations:sponsorships").get(app.id)).toBeNull();
    expect(await booted.store.records("automations:sponsored").get(app.id)).not.toBeNull();
    // Her access to the org's app goes too (§9.2's `user:` encoding).
    expect((await booted.store.records("vendo_app_grants").list({ refs: { app_id: app.id } }))
      .records.map((record) => (record.data as { principal: string }).principal))
      .toEqual(["user:omar"]);

    // The org's own app, and its automation's history, are not hers to take.
    expect(await booted.store.records("vendo_apps").get(app.id)).not.toBeNull();
    expect(await runs()).toHaveLength(1);

    // ...and the automation itself fails CLOSED: it stops and waits for an
    // adopter rather than quietly reverting to the org as its identity.
    expect(await booted.vendo.automations.tick(new Date(Date.now() + 4 * 60 * 60 * 1000))).toHaveLength(1);
    const card = await booted.vendo.automations.adoption(app.id, ctxOf(dana));
    expect(card).toMatchObject({ reason: "departure" });
    // The name went with the erase and must not come back.
    expect(card).not.toHaveProperty("sponsor");
  });
});

/** ORCHESTRATOR RULING 2026-08-01 (handoff #5) — a member's event fires the
 *  org's automations, and each run acts as its SPONSOR. Over the real
 *  composition this ALSO pins `server.ts`'s automations `memberships:` seam,
 *  which nothing else covered: without it the engine asserts no orgs for the
 *  emitter and the org's row stays unreachable. */
describe("ruling — vendo.emit fires an ORG-owned automation for a member", () => {
  it("fires for a member as the sponsor, and fires nothing for a non-member", async () => {
    const booted = await boot();
    const app = eventAutomationApp("app_org_event");
    await seedApp(booted.store, app, ORG);
    expect((await wire(booted.vendo, dana, "POST", `/apps/${app.id}/grants`, {
      principal: "user:kim",
      level: "editor",
    })).status).toBe(200);
    // Kim takes it on, so the run's identity is hers and not the org's.
    expect((await booted.vendo.automations.enable(app.id, ctxOf(kim))).enabled).toBe(true);

    // A member of the same org emits the event: the org's automation fires.
    const fired = await booted.vendo.emit("invoice.paid", {}, omar);
    expect(fired).toHaveLength(1);
    const run = await booted.vendo.automations.runs.get(fired[0]!, ctxOf(kim));
    // It got PAST the fire-time gate and into its first step, where the real
    // guard asks for the standing grant Kim has not yet approved.
    expect(run).toMatchObject({ appId: app.id, status: "pending-approval" });

    // ...and it is KIM who is being asked — the sponsor, never the org and never
    // the member whose event happened to trigger it.
    const asked = (await booted.store.records("vendo_approvals").list({})).records
      .map((record) => (record.data as { request: { ctx: { principal: { subject: string } } } })
        .request.ctx.principal.subject);
    expect(new Set(asked)).toEqual(new Set([kim.subject]));

    // Somebody the host asserts no membership for emits the very same event and
    // reaches nothing at all.
    const stranger: Principal = { kind: "user", subject: "stranger" };
    expect(await booted.vendo.emit("invoice.paid", {}, stranger)).toEqual([]);
  });
});
