import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TRIGGER_ID,
  VENDO_APP_FORMAT,
  type AppDocument,
  type Membership,
  type Principal,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { triggerKey } from "@vendoai/automations";
import { appAccess, createStore, eraseStore, storeFiles, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

/**
 * The INTEGRATION WIRINGS between orgs, apps and automations. Each test below
 * pins one composition line in `server.ts` and fails if that line is removed:
 *
 *  - `onDocumentEdit:` — a third party's edit invalidates the sponsorship
 *  - `appAccess:` (automations) — the fire-time can(editor) is the real one
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
  triggers: [{
    id: DEFAULT_TRIGGER_ID,
    on: { kind: "schedule", every: "1h" },
    run: { kind: "steps", steps: [{ id: "read", tool: READ_TOOL }] },
  }],
});

/** The same automation on a HOST EVENT, for the emit path. */
const eventAutomationApp = (id: string): AppDocument => ({
  ...automationApp(id),
  triggers: [{
    id: DEFAULT_TRIGGER_ID,
    on: { kind: "host-event", event: "invoice.paid" },
    run: { kind: "steps", steps: [{ id: "read", tool: READ_TOOL }] },
  }],
});

/** A plain app: no trigger, so it is not an automation at all. */
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
}

async function boot(): Promise<Booted> {
  const root = await mkdtemp(join(tmpdir(), "vendo-org-automation-"));
  await mkdir(join(root, ".vendo", "remixable"), { recursive: true });
  await writeFile(join(root, ".vendo", "remixable", `${SLOT}.json`), JSON.stringify(BASELINE));
  const store = createStore({ dataDir: join(root, "data") });
  cleanups.push(async () => {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  vi.stubEnv("VENDO_API_KEY", "vnd_org_automation_key");
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

  return { vendo, store };
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

const seedApp = async (store: VendoStore, app: AppDocument, subject: string): Promise<void> => {
  await store.records("vendo_apps").put({
    id: app.id,
    data: { subject, enabled: false, doc: app },
    refs: {
      subject,
      ...(app.triggers === undefined || app.triggers.length === 0
        ? {}
        : { trigger_kind: app.triggers[0]!.on.kind }),
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
  // Grant ROWS are fixture here, written through the same `appAccess(store)`
  // seam the runtime reads at fire time — the wire has no route that writes one.
  const access = appAccess(booted.store);
  await access.grant(ctxOf(dana), id, "user:kim", "editor");
  await access.grant(ctxOf(dana), id, "user:omar", "viewer");
  const armed = await booted.vendo.automations.enable(id, DEFAULT_TRIGGER_ID, ctxOf(sponsor));
  expect(armed.enabled).toBe(true);
  return app;
}

describe("a third party's edit through the real apps path invalidates the sponsorship", () => {
  it("invalidates when an EDITOR who is not the sponsor lands a document edit", async () => {
    const booted = await boot();
    const app = await sharedAutomation(booted, "app_hook");
    const sponsorship = async () =>
      (await booted.store.records("automations:sponsorships").get(triggerKey(app.id, "main")))?.data as
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

describe("the automations engine's can(editor) is the real one", () => {
  it("lets an ORG app's sponsor keep firing on a grant, and stops them once it is revoked", async () => {
    const booted = await boot();
    // Kim sponsors an app she does NOT own (the row belongs to the org), so the
    // fire-time check can only pass through `appAccess`. Unwired, it falls back
    // to ownership — "maple" !== "kim" — and the very first fire would stop.
    const app = await sharedAutomation(booted, "app_seam", kim);
    const sponsorship = async () =>
      (await booted.store.records("automations:sponsorships").get(triggerKey(app.id, "main")))?.data as
        { sponsor: string; status: string; reason?: string } | undefined;
    expect(await sponsorship()).toMatchObject({ sponsor: kim.subject, status: "active" });

    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(await booted.vendo.automations.tick(later)).toHaveLength(1);
    expect(await sponsorship()).toMatchObject({ status: "active" });

    // Revoke the grant that authorized her, and the next fire stops the run and
    // marks the sponsorship invalidated for a lost permission.
    await appAccess(booted.store).revoke(ctxOf(dana), app.id, "user:kim");
    const later2 = new Date(Date.now() + 4 * 60 * 60 * 1000);
    expect(await booted.vendo.automations.tick(later2)).toHaveLength(1);
    expect(await sponsorship()).toMatchObject({ status: "invalidated", reason: "grants" });
  });
});

/** The erase axes, over the REAL store. "The sponsor is not the row owner" is
 *  possible when an editor arms an app they do not own, and §9.7's rule is
 *  that the org outlives the person: erasing a member must take everything that
 *  was THEIRS and nothing that is the org's. */
describe("a member's erase against an org-owned automation", () => {
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
    expect(await booted.store.records("automations:sponsorships").get(triggerKey(app.id, "main"))).toBeNull();
    expect(await booted.store.records("automations:sponsored").get(triggerKey(app.id, "main"))).not.toBeNull();
    // Her access to the org's app goes too (§9.2's `user:` encoding).
    expect((await booted.store.records("vendo_app_grants").list({ refs: { app_id: app.id } }))
      .records.map((record) => (record.data as { principal: string }).principal))
      .toEqual(["user:omar"]);

    // The org's own app, and its automation's history, are not hers to take.
    expect(await booted.store.records("vendo_apps").get(app.id)).not.toBeNull();
    expect(await runs()).toHaveLength(1);

    // ...and the automation itself fails CLOSED: the sponsor is gone (the row
    // went with her, the marker stayed), so the next fire stops rather than
    // quietly reverting to the org as its identity.
    const [stoppedRunId] = await booted.vendo.automations.tick(new Date(Date.now() + 4 * 60 * 60 * 1000));
    expect(await runs()).toHaveLength(2);
    expect((await booted.vendo.automations.runs.get(stoppedRunId!, ctxOf(dana)))?.status).not.toBe("ok");
  });
});

/** ORCHESTRATOR RULING 2026-08-01 (handoff #5) — a member's event fires the
 *  org's automations, and each run acts as its SPONSOR. Over the real
 *  composition this ALSO pins `server.ts`'s automations `memberships:` seam,
 *  which nothing else covered: without it the engine asserts no orgs for the
 *  emitter and the org's row stays unreachable. */
describe("vendo.emit fires an ORG-owned automation for a member", () => {
  it("fires for a member as the sponsor, and fires nothing for a non-member", async () => {
    const booted = await boot();
    const app = eventAutomationApp("app_org_event");
    await seedApp(booted.store, app, ORG);
    await appAccess(booted.store).grant(ctxOf(dana), app.id, "user:kim", "editor");
    // Kim takes it on, so the run's identity is hers and not the org's.
    expect((await booted.vendo.automations.enable(app.id, DEFAULT_TRIGGER_ID, ctxOf(kim))).enabled).toBe(true);

    // A member of the same org emits the event: the org's automation fires.
    const fired = await booted.vendo.emit("invoice.paid", {}, omar);
    expect(fired).toHaveLength(1);
    const run = await booted.vendo.automations.runs.get(fired[0]!, ctxOf(kim));
    // It got PAST the fire-time gate and into its first step, where the real
    // guard asks for the standing grant Kim has not yet approved. There is no
    // waiting state left to land in: the run ends LOUDLY on the trigger that
    // fired, naming the tool whose permission it needed, and `runs.rerun` is how
    // it runs again once she allows it.
    expect(run).toMatchObject({
      appId: app.id,
      triggerId: DEFAULT_TRIGGER_ID,
      status: "error",
      error: { code: "needs-permission", tool: READ_TOOL },
    });

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
