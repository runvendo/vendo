import {
  VENDO_APP_FORMAT,
  type ApprovalRequest,
  type RunContext,
} from "@vendoai/core";
import {
  type AppPlan,
} from "../../src/contract/index.js";
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { scriptedLanguageModel, type ScriptedModelCall } from "../../src/server/testing/scripted-model.js";
import type { GeneratedAppDocument, HostToolInfo } from "../../src/server/generation/engine.js";
import {
  escalatedServer,
  runServerLane,
  type BoxOutcome,
  type BoxSeam,
  type ServerLaneDeps,
} from "../../src/server/generation/lanes.js";

/**
 * The server lane: the automation a plan declares, and the box — whose whole
 * law is that NOTHING is written against its functions until it says what it
 * built.
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

/** The agentic contract tells the planner to name its tools in the prompt, and a
 *  real answer does. */
const NAMED_TOOLS_PLAN = JSON.stringify({
  name: "Invoice nudge triage",
  resultsCollection: "nudges",
  trigger: {
    on: { kind: "schedule", every: "1d" },
    run: {
      kind: "agentic",
      prompt: "Read the invoices with host_listInvoices, decide who deserves a gentle vs firm nudge, "
        + `and publish the note with vendo_apps_data_put (appId "${APP_ID}", collection "nudges", id "latest").`,
      budget: { maxToolCalls: 20 },
    },
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

    expect(result.document.triggers?.[0]?.on).toEqual({ kind: "schedule", cron: "0 8 * * 5" });
    expect(result.document.storage?.digest?.kind).toBe("records");
    // The rewire survives, and the automation it was authored for survives the
    // rewire (a rebind that dropped the trigger would ship a dead automation).
    expect(result.document.name).toBe("Invoices workspace + digest");
    expect(rebinds[0]).toContain('collection:"digest"');
    expect(rebinds[0]).toContain(`appId:"${APP_ID}"`);
    expect(landed).toHaveLength(1);
    expect(landed[0]?.document.triggers?.[0]).toBeDefined();
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

  it("lands an agentic automation carrying the tools its prompt named, and nothing wider", async () => {
    // The consent card an agentic automation shows is `run.tools` when it has
    // one, and EVERY bound descriptor when it does not — which is how "review
    // the transactions and write a note" asked its owner for 31 standing
    // permissions, "Send money" among them. Authoring is the only moment that
    // knows: it wrote the prompt.
    const result = await runServerLane(agenticPlan(), document(), serverDeps(scripted([], NAMED_TOOLS_PLAN), {
      land: async () => undefined,
      armAutomation: async () => ({ enabled: true, missing: [] }),
    }));

    const run = result.automation?.trigger.run;
    if (run?.kind !== "agentic") throw new Error("the lane landed a non-agentic run");
    expect(run.tools).toEqual(["host_listInvoices", "vendo_apps_data_put"]);
  });

  it("leaves the declaration OFF a plan whose prompt names no tool, rather than declaring wide", async () => {
    // A declaration is what the plan actually implies; a guessed one would be a
    // consent card for tools nobody authored. Absent is the honest answer, and
    // the capture fallback (which withholds what can never run away) is what
    // keeps the card honest from there.
    const result = await runServerLane(agenticPlan(), document(), serverDeps(scripted([], NUDGE_PLAN), {
      land: async () => undefined,
    }));

    const run = result.automation?.trigger.run;
    if (run?.kind !== "agentic") throw new Error("the lane landed a non-agentic run");
    expect(run.tools).toBeUndefined();
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

    expect(result.document.triggers?.[0]).toBeDefined();
    expect(result.findings.map(({ message }) => message).join(" ")).toContain("was not rewired to show its results");
    expect(result.findings.every(({ severity }) => severity === "warn")).toBe(true);
  });

  it("adds a SECOND automation as its own entry: the first one survives untouched", async () => {
    // The flagship sentence of the design — "add an alert to my dashboard just
    // adds an entry". An app carries a LIST of triggers, so authoring a second
    // automation must not be authoring OVER the first: the embedded agent used
    // to answer "I can't set two separate schedules on the same app" because
    // every plan landed on the `main` entry.
    const first = await runServerLane(stepsPlan(), document(), serverDeps(scripted([], DIGEST_PLAN), {
      land: async () => undefined,
    }));
    expect(first.document.triggers?.map(({ id }) => id)).toEqual(["main"]);

    const armed: string[] = [];
    const second = await runServerLane(agenticPlan(), first.document, serverDeps(scripted([], NUDGE_PLAN), {
      land: async () => undefined,
      armAutomation: async (_appId, triggerId) => {
        armed.push(triggerId);
        return { enabled: true, missing: [] };
      },
    }));

    expect(second.document.triggers?.map(({ id }) => id)).toEqual(["main", "invoice_nudge_triage"]);
    // Byte-identical: the first automation's own schedule, steps and id are not
    // this authoring's business.
    expect(second.document.triggers?.[0]).toEqual(first.document.triggers?.[0]);
    // And only the NEW trigger is armed. Arming re-captures a trigger's grants,
    // so re-arming the sibling would re-mint consent nobody asked to revisit.
    expect(armed).toEqual(["invoice_nudge_triage"]);
    expect(second.automation?.trigger.id).toBe("invoice_nudge_triage");
    expect(second.automation?.trigger.run.kind).toBe("agentic");
  });

  it("refuses to land an ADD ask on an existing entry, however the plan tries to", async () => {
    // The live failure this closes: in-thread, the model DID call vendo_make with
    // "add a second schedule alongside", and the app came back holding one
    // trigger. The planner is its own model call, it never saw those words, and
    // an existing `main` in front of it is an invitation to tidy up — one lazy
    // `"replaces":"main"` and the person's first automation is gone. An ask that
    // says "another one" may not resolve to an existing entry at all.
    const ADD_ASK = "add a second schedule alongside the daily nudge — a weekly summary on Fridays";
    const before = document();
    before.triggers = [{
      id: "main",
      on: { kind: "schedule", every: "1d" },
      run: { kind: "agentic", prompt: "The daily nudge." },
    }];
    const LAZY_REPLACE = JSON.stringify({
      name: "Weekly nudge summary",
      replaces: "main",
      trigger: {
        on: { kind: "schedule", every: "7d" },
        run: { kind: "agentic", prompt: "Weigh up the week's nudges.", budget: { maxToolCalls: 20 } },
      },
    });

    const result = await runServerLane(agenticPlan(), before, serverDeps(scripted([], LAZY_REPLACE), {
      request: ADD_ASK,
      land: async () => undefined,
    }));

    expect(result.document.triggers?.map(({ id }) => id)).toEqual(["main", "weekly_nudge_summary"]);
    expect(result.document.triggers?.[0]?.run).toEqual({ kind: "agentic", prompt: "The daily nudge." });
    expect(result.automation?.trigger.id).toBe("weekly_nudge_summary");
  });

  it("keeps an ADD ask off an existing entry even when the plan reuses its name", async () => {
    // The same hole through the other door: a plan that names the new automation
    // exactly what the old one is called would land on it by name identity.
    const before = document();
    before.triggers = [{
      id: "invoice_nudge_triage",
      on: { kind: "schedule", every: "1d" },
      run: { kind: "agentic", prompt: "The daily nudge." },
    }];
    const SAME_NAME = JSON.stringify({
      name: "Invoice nudge triage",
      trigger: {
        on: { kind: "schedule", every: "7d" },
        run: { kind: "agentic", prompt: "Weigh up the week's nudges.", budget: { maxToolCalls: 20 } },
      },
    });

    const result = await runServerLane(agenticPlan(), before, serverDeps(scripted([], SAME_NAME), {
      request: "also nudge them a second time each week",
      land: async () => undefined,
    }));

    expect(result.document.triggers?.map(({ id }) => id)).toEqual(["invoice_nudge_triage", "invoice_nudge_triage_2"]);
    expect(result.document.triggers?.[0]?.run).toEqual({ kind: "agentic", prompt: "The daily nudge." });
  });

  it("reads a trailing \"too\" as another one, the way people actually say it", async () => {
    const before = document();
    before.triggers = [{
      id: "main",
      on: { kind: "schedule", every: "1d" },
      run: { kind: "agentic", prompt: "The daily nudge." },
    }];
    const LAZY_REPLACE = JSON.stringify({
      name: "Weekly nudge summary",
      replaces: "main",
      trigger: {
        on: { kind: "schedule", every: "7d" },
        run: { kind: "agentic", prompt: "Weigh up the week's nudges.", budget: { maxToolCalls: 20 } },
      },
    });

    const result = await runServerLane(agenticPlan(), before, serverDeps(scripted([], LAZY_REPLACE), {
      request: "remind me weekly too",
      land: async () => undefined,
    }));

    expect(result.document.triggers?.map(({ id }) => id)).toEqual(["main", "weekly_nudge_summary"]);
  });

  it("hands the planner the person's own words, not only the plan's reason", async () => {
    // The planner decides create-vs-edit, and it was deciding it without ever
    // seeing the request that started all this.
    const calls: ScriptedModelCall[] = [];
    await runServerLane(agenticPlan(), document(), serverDeps(scripted(calls, NUDGE_PLAN), {
      request: "also send me a weekly summary of what got nudged",
      land: async () => undefined,
    }));

    expect(promptText(calls[0])).toContain("also send me a weekly summary of what got nudged");
  });

  it("changes the automation the ask is about instead of adding a second one, when the plan names it", async () => {
    // The other half of the same law. The app's ONE automation sits under the
    // default `main` id, which carries no name to match a fresh plan against, so
    // "move the digest to 9am" is only distinguishable from "also send me a
    // weekly one" by the planner — which reads the request and the app's list.
    const before = document();
    before.triggers = [{
      id: "main",
      on: { kind: "schedule", cron: "0 8 * * 5" },
      run: { kind: "steps", steps: [{ id: "invoices", tool: "host_listInvoices" }] },
    }];
    const calls: ScriptedModelCall[] = [];
    const MOVED = JSON.stringify({
      name: "Unpaid invoice digest",
      replaces: "main",
      resultsCollection: "digest",
      trigger: {
        on: { kind: "schedule", cron: "0 9 * * 5" },
        run: {
          kind: "steps",
          steps: [
            { id: "invoices", tool: "host_listInvoices" },
            { id: "publish", tool: "vendo_apps_data_put", args: { appId: `'${APP_ID}'`, collection: "'digest'", id: "'latest'", data: "steps.invoices" } },
          ],
        },
      },
    });

    const result = await runServerLane(stepsPlan(), before, serverDeps(scripted(calls, MOVED), {
      land: async () => undefined,
    }));

    expect(result.document.triggers?.map(({ id }) => id)).toEqual(["main"]);
    expect(result.document.triggers?.[0]?.on).toEqual({ kind: "schedule", cron: "0 9 * * 5" });
    // It could not have named that entry without being told what this app
    // already runs.
    expect(promptText(calls[0])).toContain("main: schedule");
  });

  it("repairs a plan that claims to replace an automation the app does not have", async () => {
    const before = document();
    before.triggers = [{ id: "main", on: { kind: "schedule", every: "1d" }, run: { kind: "agentic", prompt: "As it stood." } }];
    const calls: ScriptedModelCall[] = [];
    const GHOST = JSON.stringify({
      name: "Invoice nudge triage",
      replaces: "not_a_trigger_of_this_app",
      trigger: {
        on: { kind: "schedule", every: "1d" },
        run: { kind: "agentic", prompt: "Decide who deserves a gentle vs firm nudge.", budget: { maxToolCalls: 20 } },
      },
    });

    const result = await runServerLane(agenticPlan(), before, serverDeps(scripted(calls, GHOST), {
      land: async () => undefined,
    }));

    // Dropping the reference would silently turn a change to one automation into
    // a second one beside it — the exact confusion `replaces` exists to end — so
    // the planner is asked to fix it, with the app's own ids in the sentence.
    const repair = promptText(calls[1]);
    expect(repair).toContain("must name one of this app's own automations: main");
    // Nothing landed on a plan that never validated; the app stands as it was.
    expect(result.document).toEqual(before);
    expect(result.automation).toBeUndefined();
  });

  it("replaces the entry of the automation it is an edit of, and no sibling's", async () => {
    const before = document();
    before.triggers = [
      { id: "main", on: { kind: "schedule", cron: "0 8 * * 5" }, run: { kind: "steps", steps: [{ id: "rows", tool: "host_listInvoices" }] } },
      { id: "invoice_nudge_triage", on: { kind: "schedule", every: "1d" }, run: { kind: "agentic", prompt: "The nudge as it stood." } },
    ];
    const firstAsItStood = structuredClone(before.triggers[0]);
    const REPLANNED = JSON.stringify({
      // The SAME automation, said again: same name, new cadence.
      name: "Invoice nudge triage",
      trigger: {
        on: { kind: "schedule", every: "2d" },
        run: { kind: "agentic", prompt: "Decide who deserves a gentle vs firm nudge, every other day.", budget: { maxToolCalls: 20 } },
      },
    });

    const result = await runServerLane(agenticPlan(), before, serverDeps(scripted([], REPLANNED), {
      land: async () => undefined,
    }));

    expect(result.document.triggers?.map(({ id }) => id)).toEqual(["main", "invoice_nudge_triage"]);
    expect(result.document.triggers?.[1]?.on).toEqual({ kind: "schedule", every: "2d" });
    expect(result.document.triggers?.[0]).toEqual(firstAsItStood);
  });

  it("stamps the rewired document onto the SAME entry: one automation, not two", async () => {
    // applyAutomationPlan runs twice for one authoring — once before the board
    // rewire and once over the rewired document — so the id it lands under has
    // to be decided ONCE. A second derivation would append a duplicate.
    const landed: Array<GeneratedAppDocument> = [];
    const result = await runServerLane(stepsPlan(), document(), serverDeps(scripted([], DIGEST_PLAN), {
      rebind: async (_instruction, doc) => ({ document: { ...doc, name: "Invoices workspace + digest" }, issues: [] }),
      land: async (doc) => { landed.push(doc); },
    }));

    expect(result.document.triggers).toHaveLength(1);
    expect(landed[0]?.triggers).toHaveLength(1);
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
// Which lane an ESCALATED plan runs in
// ---------------------------------------------------------------------------

describe("escalatedServer", () => {
  it("keeps the kind the escalating agent declared — the tag is the whole decision", () => {
    // Nothing re-derives the lane: the agent that could not assemble the screen
    // is the one that knows why, and it said so in the plan.
    expect(escalatedServer(stepsPlan(), "the escalation's own sentence")).toEqual({
      kind: "steps",
      schedule: "fridays at 8am",
      why: "the digest has to be emailed while nobody is looking at the app",
    });
    expect(escalatedServer(agenticPlan(), "the escalation's own sentence").kind).toBe("agentic");
    expect(escalatedServer(boxPlan(), "the escalation's own sentence").why)
      .toBe("reconciling the uploads needs custom dedup logic no tool can express");
  });

  it("defaults a plan with NO <Server> to the box, on the escalation's own reason", () => {
    // The escalation is itself the claim that assembly cannot serve this ask,
    // and steps/agentic only author automations over tools assembly already
    // had — defaulting there would answer the escalation with the rung it
    // already ruled out.
    const plan = { ...stepsPlan(), server: undefined };
    expect(escalatedServer(plan, "the uploads have to be reconciled outside the browser")).toEqual({
      kind: "box",
      why: "the uploads have to be reconciled outside the browser",
    });
  });
});
