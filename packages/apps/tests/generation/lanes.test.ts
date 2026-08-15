import {
  VENDO_APP_FORMAT,
  type RunContext,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { scriptedLanguageModel } from "../../src/server/testing/scripted-model.js";
import type { GeneratedAppDocument, HostToolInfo } from "../../src/server/generation/engine.js";
import {
  runServerLane,
  type BoxOutcome,
  type BoxSeam,
  type ServerLaneDeps,
} from "../../src/server/generation/lanes.js";

/**
 * The server lane: the box, whose whole law is that NOTHING is written against
 * its functions until it says what it built.
 *
 * There is exactly ONE lane. Authoring an automation never needed a machine, so
 * it is a door of its own (`server/automation/lane.ts`).
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

/** The lane never asks a model anything — the box does. */
const model = scriptedLanguageModel(() => "unused");

const APP_ID = "app_lanes";

/** The person's own words, and the escalation's one-line why: the whole brief. */
const REQUEST = "reconcile the CSVs I upload into one ledger, newest first";
const WHY = "reconciling the uploads needs custom dedup logic no tool can express";

const serverDeps = (overrides: Partial<ServerLaneDeps> = {}): ServerLaneDeps => ({
  model,
  catalog: [],
  tools,
  appId: APP_ID,
  ctx,
  request: REQUEST,
  why: WHY,
  ...overrides,
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
    await runServerLane(document(), serverDeps({ box: seam }));

    const instruction = state.instructions[0] ?? "";
    expect(instruction).toContain(WHY);
    expect(instruction).toContain(REQUEST);
    expect(instruction).toContain("report the interface you ended up serving");
    // The law: nothing the app will bind to exists in the instruction — not the
    // function the box goes on to write, and not an fn: reference to it.
    expect(instruction).not.toContain("reconciledLedger");
    expect(instruction).not.toContain("fn:");
  });

  it("returns the interface the box reports, with the samples its own code produced", async () => {
    const { seam, state } = fakeBox(BUILT_LEDGER);
    const result = await runServerLane(document(), serverDeps({ box: seam }));

    expect(state.provisions).toBe(1);
    expect(result.server?.functions).toEqual([
      { name: "reconciledLedger", sampleOutput: { rows: [{ client: "Acme", cents: 420000 }] } },
    ]);
    expect(result.findings).toEqual([]);
  });

  it("reports a box that built something but named no functions, so the waiting sections say so", async () => {
    const { seam } = fakeBox({ ok: true, summary: "tidied the scaffold" });
    const result = await runServerLane(document(), serverDeps({ box: seam }));

    expect(result.server?.functions).toEqual([]);
    expect(result.findings.map(({ message }) => message).join(" ")).toContain("named no functions");
  });

  it("leaves the document unchanged and keeps no snapshot when the box fails", async () => {
    const { seam, state } = fakeBox({ ok: false, summary: "the dedup tests never passed" });
    const before = document();
    const result = await runServerLane(before, serverDeps({ box: seam }));

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
    const result = await runServerLane(before, serverDeps({ box: seam }));

    expect(state.provisions).toBe(0);
    expect(state.instructions).toEqual([]);
    expect(result.document).toEqual(before);
    expect(result.findings[0]?.message).toContain("cannot provision a machine");
  });

  it("refuses the same way when there is no box seam at all", async () => {
    const before = document();
    const result = await runServerLane(before, serverDeps());

    expect(result.document).toEqual(before);
    expect(result.findings[0]?.message).toContain("cannot provision a machine");
  });
});
