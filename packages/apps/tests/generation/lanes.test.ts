import {
  VENDO_APP_FORMAT,
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
 * The server lane: the box, whose whole law is that NOTHING is written against
 * its functions until it says what it built.
 *
 * The steps/agentic cases died with those `<Server kind>` branches — authoring
 * an automation is its own door now (`server/automation/lane.ts`).
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

const serverDeps = (model: LanguageModel, overrides: Partial<ServerLaneDeps> = {}): ServerLaneDeps => ({
  model,
  catalog: [],
  tools,
  appId: APP_ID,
  ctx,
  ...overrides,
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
