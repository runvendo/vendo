import {
  VENDO_APP_FORMAT,
  type AppPlan,
  type ApprovalRequest,
  type RunContext,
  type ShapeType,
} from "@vendoai/core";
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { scriptedLanguageModel, type ScriptedModelCall } from "../testing/index.js";
import type { GeneratedAppDocument, HostToolInfo } from "./engine.js";
import {
  laneGates,
  runIslandLane,
  runServerLane,
  type BoxOutcome,
  type BoxSeam,
  type IslandLaneDeps,
  type ServerLaneDeps,
} from "./lanes.js";

/**
 * The rare lanes (generation pipeline rebuild, Task 8): the island the plan
 * declares, the automation it declares, and the box — whose whole law is that
 * NOTHING is written against its functions until it says what it built.
 */

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

const tools: HostToolInfo[] = [
  { name: "host_listInvoices", description: "Every invoice with its amount and due date.", risk: "read" },
  { name: "host_send_email", description: "Send an email.", risk: "write", inputSchema: { type: "object", properties: { subject: {}, body: {} } } },
  { name: "vendo_apps_data_put", description: "Publish an app record.", risk: "write" },
  { name: "vendo_apps_data_list", description: "Read app records.", risk: "read" },
];

const invoiceShape: ShapeType = {
  kind: "array",
  items: { kind: "object", fields: { client: { kind: "string" }, amountCents: { kind: "number" } } },
};

const document = (): GeneratedAppDocument => ({
  format: VENDO_APP_FORMAT,
  name: "Invoices workspace",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "app",
    nodes: [{ id: "app", component: "Stack", source: "prewired", children: [] }],
  } as GeneratedAppDocument["tree"],
});

/** A scripted model that also records every prompt it was handed. */
const scripted = (calls: ScriptedModelCall[], ...answers: string[]): LanguageModel =>
  scriptedLanguageModel((call, index) => {
    calls.push(call);
    return answers[Math.min(index, answers.length - 1)] as string;
  });

const promptText = (call: ScriptedModelCall | undefined): string => (call?.prompt ?? []).map((message) => (
  typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("")
)).join("\n");

// ---------------------------------------------------------------------------
// The island lane
// ---------------------------------------------------------------------------

const islandPlan = (): AppPlan => ({
  name: "Invoices workspace",
  queries: [{ id: "invoices", tool: "host_listInvoices", input: { limit: 50 } }],
  groups: [{
    tab: "Overview",
    leaves: [{ component: "SpendHeatmap", query: "invoices", purpose: "Spend by day, darker where more money left" }],
  }],
  island: { name: "SpendHeatmap", purpose: "A day-by-day heat grid of spend" },
  cannot: [],
});

/** Reaches for the network — the sandbox has none, so this island would render
 *  a permanent empty grid in production. */
const NETWORK_ISLAND = `<Island name="SpendHeatmap">
export default function SpendHeatmap() {
  const [live, setLive] = React.useState([]);
  React.useEffect(() => { fetch("/api/spend").then((response) => response.json()).then(setLive); }, []);
  return <div>{live.length}</div>;
}
</Island>`;

/** Static reads pass; it crashes the moment it renders without rows. */
const CRASHING_ISLAND = `<Island name="SpendHeatmap">
export default function SpendHeatmap({ rows }) {
  return <div>{rows.map((row, index) => <span key={index}>{fmt.money(row.amountCents)}</span>)}</div>;
}
</Island>`;

const GOOD_ISLAND = `<Island name="SpendHeatmap">
export default function SpendHeatmap({ rows }) {
  const cells = Array.isArray(rows) ? rows : [];
  return <div>{cells.map((cell, index) => <span key={index}>{fmt.money(cell.amountCents)}</span>)}</div>;
}
</Island>`;

const islandDeps = (model: LanguageModel, overrides: Partial<IslandLaneDeps> = {}): IslandLaneDeps => ({
  model,
  catalog: [],
  tools,
  toolShapes: { host_listInvoices: invoiceShape },
  ...overrides,
});

describe("runIslandLane", () => {
  it("screens the island through prepareIslands: a network-violating island is rejected with the teaching message", async () => {
    const calls: ScriptedModelCall[] = [];
    const before = document();
    const result = await runIslandLane(islandPlan(), before, islandDeps(scripted(calls, NETWORK_ISLAND)));

    expect(result.findings.map(({ message }) => message).join(" ")).toContain("an island has no network");
    expect(result.findings.every(({ severity }) => severity === "warn")).toBe(true);
    expect(result.document).toEqual(before);
    // The retry is handed the teaching sentence, not just "try again".
    expect(promptText(calls[1])).toContain("an island has no network");
  });

  it("writes the island against its plan's purpose and query shapes", async () => {
    const calls: ScriptedModelCall[] = [];
    await runIslandLane(islandPlan(), document(), islandDeps(scripted(calls, GOOD_ISLAND), { pipeline: { smokeRender: false } }));

    const prompt = promptText(calls[0]);
    expect(prompt).toContain("ISLAND: SpendHeatmap");
    expect(prompt).toContain("A day-by-day heat grid of spend");
    expect(prompt).toContain("invoices: host_listInvoices");
    expect(prompt).toContain("amountCents");
  });

  it("takes one fix-it retry with the issues and lands the corrected island", async () => {
    const calls: ScriptedModelCall[] = [];
    const result = await runIslandLane(islandPlan(), document(), islandDeps(scripted(calls, NETWORK_ISLAND, GOOD_ISLAND)));

    expect(calls).toHaveLength(2);
    expect(result.findings).toEqual([]);
    expect(result.document.components?.SpendHeatmap).toContain("export default function SpendHeatmap");
    // The per-island tool manifest is stamped even when it is empty (least
    // privilege: this island reads no tools of its own).
    expect(result.document.componentTools?.SpendHeatmap).toEqual([]);
  });

  it("screens through the smoke render too: a crash no static read can see drives the retry", async () => {
    const calls: ScriptedModelCall[] = [];
    const result = await runIslandLane(islandPlan(), document(), islandDeps(scripted(calls, CRASHING_ISLAND, GOOD_ISLAND)));

    expect(promptText(calls[1])).toContain("crashed");
    expect(result.findings).toEqual([]);
    expect(result.document.components?.SpendHeatmap).toContain("Array.isArray(rows)");
  });

  it("fails honestly after the retry: the document is unchanged and the app stands without the island", async () => {
    const calls: ScriptedModelCall[] = [];
    const before = document();
    const result = await runIslandLane(islandPlan(), before, islandDeps(scripted(calls, NETWORK_ISLAND, NETWORK_ISLAND)));

    expect(calls).toHaveLength(2);
    expect(result.document).toEqual(before);
    expect(result.document.components).toBeUndefined();
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.every(({ severity, where }) => severity === "warn" && where === 'island "SpendHeatmap"')).toBe(true);
  });

  it("does nothing at all when the plan declared no island", async () => {
    const calls: ScriptedModelCall[] = [];
    const plan = { ...islandPlan(), island: undefined };
    const before = document();
    const result = await runIslandLane(plan, before, islandDeps(scripted(calls, GOOD_ISLAND)));

    expect(calls).toEqual([]);
    expect(result).toEqual({ document: before, findings: [] });
  });
});

// ---------------------------------------------------------------------------
// The server lane — steps / agentic
// ---------------------------------------------------------------------------

const APP_ID = "app_lanes";

const stepsPlan = (): AppPlan => ({
  name: "Invoices workspace",
  queries: [],
  groups: [{ title: "Health", leaves: [{ component: "Stat", purpose: "Total outstanding" }] }],
  server: { kind: "steps", schedule: "fridays at 8am", why: "the digest has to be emailed while nobody is looking at the app" },
  cannot: [],
});

const agenticPlan = (): AppPlan => ({
  ...stepsPlan(),
  server: { kind: "agentic", schedule: "every day", why: "each invoice needs a judgment call on how firm the nudge should be" },
});

const DIGEST_PLAN = JSON.stringify({
  name: "Unpaid invoice digest",
  resultsCollection: "digest",
  trigger: {
    on: { kind: "schedule", cron: "0 8 * * 5" },
    run: {
      kind: "steps",
      steps: [
        { id: "invoices", tool: "host_listInvoices" },
        { id: "email", tool: "host_send_email", args: { subject: "'Unpaid invoice digest'", body: "steps.invoices" } },
        { id: "publish", tool: "vendo_apps_data_put", args: { appId: `'${APP_ID}'`, collection: "'digest'", id: "'latest'", data: "steps.invoices" } },
      ],
    },
  },
});

const NUDGE_PLAN = JSON.stringify({
  name: "Invoice nudge triage",
  trigger: {
    on: { kind: "schedule", every: "1d" },
    run: { kind: "agentic", prompt: "Decide who deserves a gentle vs firm nudge and draft accordingly.", budget: { maxToolCalls: 20 } },
  },
});

const pendingApproval = (): ApprovalRequest => ({
  id: "apr_email",
  call: { id: "call_1", tool: "host_send_email", args: {} },
  descriptor: { name: "host_send_email", description: "Send an email.", inputSchema: { type: "object" }, risk: "write" },
  inputPreview: "host_send_email({})",
  ctx: { principal: ctx.principal, venue: ctx.venue, presence: ctx.presence },
  createdAt: new Date().toISOString(),
});

const serverDeps = (model: LanguageModel, overrides: Partial<ServerLaneDeps> = {}): ServerLaneDeps => ({
  model,
  catalog: [],
  tools,
  appId: APP_ID,
  ctx,
  ...overrides,
});

describe("runServerLane — steps and agentic automations", () => {
  it("arms a trigger, declares its results storage, and binds the board to the results collection", async () => {
    const calls: ScriptedModelCall[] = [];
    const rebinds: string[] = [];
    const landed: Array<{ document: GeneratedAppDocument; armTrigger: boolean }> = [];

    const result = await runServerLane(stepsPlan(), document(), serverDeps(scripted(calls, DIGEST_PLAN), {
      rebind: async (instruction, doc) => {
        rebinds.push(instruction);
        return { document: { ...doc, name: "Invoices workspace + digest" }, issues: [] };
      },
      land: async (doc, options) => { landed.push({ document: doc, armTrigger: options.armTrigger }); },
    }));

    expect(result.document.trigger?.on).toEqual({ kind: "schedule", cron: "0 8 * * 5" });
    expect(result.document.storage?.digest?.kind).toBe("records");
    // The rewire survives, and the automation it was authored for survives the
    // rewire (a rebind that dropped the trigger would ship a dead automation).
    expect(result.document.name).toBe("Invoices workspace + digest");
    expect(rebinds[0]).toContain('collection:"digest"');
    expect(rebinds[0]).toContain(`appId:"${APP_ID}"`);
    expect(landed).toHaveLength(1);
    expect(landed[0]?.document.trigger).toBeDefined();
    // No arming seam wired → the persist arms the stored row itself.
    expect(landed[0]?.armTrigger).toBe(true);
    expect(result.automation).toMatchObject({ mode: "steps", resultsCollection: "digest" });
    expect(result.findings).toEqual([]);
  });

  it("arms an agentic automation through the host's seam and surfaces the grants it is missing", async () => {
    const landed: Array<{ armTrigger: boolean }> = [];
    const result = await runServerLane(agenticPlan(), document(), serverDeps(scripted([], NUDGE_PLAN), {
      land: async (_doc, options) => { landed.push({ armTrigger: options.armTrigger }); },
      armAutomation: async () => ({ enabled: true, missing: [pendingApproval()] }),
    }));

    expect(result.automation?.mode).toBe("agentic");
    expect(result.automation?.trigger.run.kind).toBe("agentic");
    // The seam owns arming, so the persist must not arm the row behind it.
    expect(landed[0]?.armTrigger).toBe(false);
    expect(result.automation?.pendingGrants?.[0]?.id).toBe("apr_email");
    expect(result.findings).toEqual([]);
  });

  it("says out loud when the arming seam leaves the trigger disabled", async () => {
    const result = await runServerLane(agenticPlan(), document(), serverDeps(scripted([], NUDGE_PLAN), {
      land: async () => undefined,
      armAutomation: async () => ({ enabled: false, missing: [] }),
    }));

    expect(result.automation?.mode).toBe("agentic");
    expect(result.findings.map(({ message }) => message).join(" ")).toContain("left it disabled");
  });

  it("reports an UNLANDED automation as not enabled: with no land seam nothing was stored, so nothing was armed", async () => {
    // The `land` contract: absent, the lane authors the automation and hands it
    // back unlanded, and arms NOTHING (arming a row whose trigger is not stored
    // would enable an automation that does not exist). Reporting `enabled: true`
    // there would tell the thread's automation card an unstored trigger is live.
    const result = await runServerLane(agenticPlan(), document(), serverDeps(scripted([], NUDGE_PLAN)));

    expect(result.automation?.mode).toBe("agentic");
    expect(result.automation?.enabled).toBe(false);
  });

  it("keeps the automation when the board rewire fails, and reports the missing board", async () => {
    const result = await runServerLane(stepsPlan(), document(), serverDeps(scripted([], DIGEST_PLAN), {
      rebind: async () => ({ issues: ["binding /results/records/0 does not exist"] }),
      land: async () => undefined,
    }));

    expect(result.document.trigger).toBeDefined();
    expect(result.findings.map(({ message }) => message).join(" ")).toContain("was not rewired to show its results");
    expect(result.findings.every(({ severity }) => severity === "warn")).toBe(true);
  });

  it("fails honestly when no automation plan validates: the app stands unchanged", async () => {
    const before = document();
    const result = await runServerLane(stepsPlan(), before, serverDeps(scripted([], "not an automation plan at all")));

    expect(result.document).toEqual(before);
    expect(result.automation).toBeUndefined();
    expect(result.findings[0]?.severity).toBe("warn");
    expect(result.findings.map(({ message }) => message).join(" ")).toContain("no valid plan validated");
  });
});

// ---------------------------------------------------------------------------
// The server lane — the box (bind after build)
// ---------------------------------------------------------------------------

const boxPlan = (): AppPlan => ({
  name: "Ledger workspace",
  queries: [],
  groups: [
    { title: "Uploads", leaves: [{ component: "DataTable", purpose: "the CSVs that landed today" }] },
    { title: "Ledger", waitsForServer: true, leaves: [{ component: "DataTable", purpose: "the reconciled ledger, newest first" }] },
  ],
  server: { kind: "box", why: "reconciling the uploads needs custom dedup logic no tool can express" },
  cannot: [],
});

/** A box that models the host's own rollback: a successful edit snapshots the
 *  new code, a failed one is discarded WITHOUT a snapshot (runtime.ts
 *  editServerViaBox). */
const fakeBox = (outcome: BoxOutcome, available = true) => {
  const state = { provisions: 0, instructions: [] as string[], snapshots: 0, discarded: false };
  const seam: BoxSeam = {
    available: () => available,
    provision: async () => { state.provisions += 1; },
    instruct: async (instruction) => {
      state.instructions.push(instruction);
      if (outcome.ok) state.snapshots += 1;
      else state.discarded = true;
      return outcome;
    },
  };
  return { seam, state };
};

const BUILT_LEDGER: BoxOutcome = {
  ok: true,
  summary: "wrote the reconciliation ledger and verified it",
  functions: [{ name: "reconciledLedger", sampleOutput: { rows: [{ client: "Acme", cents: 420000 }] } }],
};

describe("runServerLane — the box binds after build", () => {
  it("sends the box no function signatures: it states the need and asks what got built", async () => {
    const { seam, state } = fakeBox(BUILT_LEDGER);
    await runServerLane(boxPlan(), document(), serverDeps(scripted([], "unused"), { box: seam }));

    const instruction = state.instructions[0] ?? "";
    expect(instruction).toContain("custom dedup logic");
    expect(instruction).toContain("the reconciled ledger, newest first");
    expect(instruction).toContain("report the interface you ended up serving");
    // The law: nothing the app will bind to exists in the instruction — not the
    // function the box goes on to write, and not an fn: reference to it.
    expect(instruction).not.toContain("reconciledLedger");
    expect(instruction).not.toContain("fn:");
  });

  it("returns the interface the box reports, with the samples its own code produced", async () => {
    const { seam, state } = fakeBox(BUILT_LEDGER);
    const result = await runServerLane(boxPlan(), document(), serverDeps(scripted([], "unused"), { box: seam }));

    expect(state.provisions).toBe(1);
    expect(result.server?.functions).toEqual([
      { name: "reconciledLedger", sampleOutput: { rows: [{ client: "Acme", cents: 420000 }] } },
    ]);
    expect(result.findings).toEqual([]);
  });

  it("reports a box that built something but named no functions, so the waiting sections say so", async () => {
    const { seam } = fakeBox({ ok: true, summary: "tidied the scaffold" });
    const result = await runServerLane(boxPlan(), document(), serverDeps(scripted([], "unused"), { box: seam }));

    expect(result.server?.functions).toEqual([]);
    expect(result.findings.map(({ message }) => message).join(" ")).toContain("named no functions");
  });

  it("leaves the document unchanged and keeps no snapshot when the box fails", async () => {
    const { seam, state } = fakeBox({ ok: false, summary: "the dedup tests never passed" });
    const before = document();
    const result = await runServerLane(boxPlan(), before, serverDeps(scripted([], "unused"), { box: seam }));

    expect(result.document).toEqual(before);
    expect(result.server).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe("warn");
    expect(result.findings[0]?.message).toContain("could not build the server work");
    expect(state.snapshots).toBe(0);
    expect(state.discarded).toBe(true);
  });

  it("refuses before provisioning anything when the host cannot run a box", async () => {
    const { seam, state } = fakeBox(BUILT_LEDGER, false);
    const before = document();
    const result = await runServerLane(boxPlan(), before, serverDeps(scripted([], "unused"), { box: seam }));

    expect(state.provisions).toBe(0);
    expect(state.instructions).toEqual([]);
    expect(result.document).toEqual(before);
    expect(result.findings[0]?.message).toContain("cannot provision a machine");
  });

  it("does nothing at all when the plan declared no server work", async () => {
    const plan = { ...boxPlan(), server: undefined };
    const before = document();
    const result = await runServerLane(plan, before, serverDeps(scripted([], "unused")));

    expect(result).toEqual({ document: before, findings: [] });
  });
});

// ---------------------------------------------------------------------------
// The gates the brain hears BEFORE it plans
// ---------------------------------------------------------------------------

describe("laneGates", () => {
  it("yields the cannot reasons when the host's machine flags are off", () => {
    const gates = laneGates({ machine: { sandbox: {} } });

    expect(gates.box).toBe(false);
    expect(gates.served).toBe(false);
    expect(gates.cannot.join(" ")).toContain("machines disabled");
    expect(gates.cannot.join(" ")).toContain("automations engine");
  });

  it("says a host with no sandbox at all cannot run server code, flag or no flag", () => {
    const gates = laneGates({ experimentalMachines: true });

    expect(gates.box).toBe(false);
    expect(gates.cannot.join(" ")).toContain("no sandbox configured");
  });

  it("opens the box lane when the host has a sandbox and the flag on, and served only with a door to serve THROUGH", () => {
    // A box with no `servedProxyPath` has no authenticated door to answer a
    // served app on, so it cannot serve one — and the brain hears that as a
    // <Cannot> BEFORE it plans, instead of after a machine has been built and
    // the surface flipped to something no caller can open.
    const unwired = laneGates({ machine: { sandbox: {} }, experimentalMachines: true });
    expect(unwired.box).toBe(true);
    expect(unwired.served).toBe(false);
    expect(unwired.cannot.join(" ")).toContain("cannot serve its own web pages");

    const wired = laneGates({
      machine: { sandbox: {} },
      experimentalMachines: true,
      servedProxyPath: () => "/api/vendo/apps/a/serve/",
    });
    expect(wired.served).toBe(true);
    expect(wired.cannot).toEqual([]);
  });

  /** Served is a MACHINE surface — it is served BY a box. That used to be held
      by a composition-time refusal on two flags agreeing with each other
      (`experimentalServedApps requires experimentalMachines`). With the served
      flag gone the relationship is not a rule to remember, it is the shape of
      the expression: served is a narrowing of box, so no box can never be
      served. */
  it("never opens the served lane without the box lane it is served by", () => {
    const proxy = () => "/api/vendo/apps/a/serve/";

    // Machines off: a sandbox and a door are not enough.
    expect(laneGates({ machine: { sandbox: {} }, servedProxyPath: proxy }).served).toBe(false);
    // No sandbox at all: nothing to provision, flag and door notwithstanding.
    expect(laneGates({ experimentalMachines: true, servedProxyPath: proxy }).served).toBe(false);

    for (const config of [
      { machine: { sandbox: {} }, servedProxyPath: proxy },
      { experimentalMachines: true, servedProxyPath: proxy },
      { machine: { sandbox: {} }, experimentalMachines: true, servedProxyPath: proxy },
    ]) {
      const gates = laneGates(config);
      expect(gates.served).toBe(gates.box);
    }
  });
});
