/**
 * The receipt is words; the CARD is the envelope's surface (#881).
 *
 * Two things are pinned here, and both are seams this package is the PRODUCING
 * side of. The card `vendo_make` publishes is parsed back with core's own
 * `vendoAutomationPartSchema` — the schema every downstream reader validates
 * with — so a part shaped for nothing to read cannot pass. And the schedule half
 * of a COMPOUND ask reaches the automation door, which is the only route from
 * `vendo_make` to the one create operation.
 */
import {
  VENDO_APP_FORMAT,
  VENDO_VIEW_STREAM,
  vendoAutomationPartSchema,
  type AutomationRecord,
  type RunContext,
  type VendoViewStreamUpdate,
  type VendoViewStreamingToolCall,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import type { AgentToolsDataDependencies } from "../src/server/doors/agent-tools.js";
import { runMakeTool } from "../src/server/doors/make-tool.js";
import type { AppsRuntime, AutomationAuthorResult, CreateServerWork } from "../src/server/runtime/types.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

const RECORD: AutomationRecord = {
  id: "atm_nudges",
  owner: ctx.principal,
  when: { kind: "schedule", every: "1d" },
  task: { kind: "goal", prompt: "Decide who deserves a nudge.", budget: { maxToolCalls: 5 } },
  armed: true,
  authoredBy: "chat",
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
};

const AUTOMATION: NonNullable<CreateServerWork["automation"]> = { record: RECORD, enabled: true };

/** The one door under test is the PUBLICATION seam, so the runtime is a fake:
 *  a create that hands back whatever server-work outcome the case needs, and an
 *  automation door that records what the compound path asked it for. */
const runtimeWith = (
  work: CreateServerWork | undefined,
  authored?: AutomationAuthorResult,
): { runtime: AppsRuntime; asked: Array<{ appId: string; instruction: string; mode: string }> } => {
  const asked: Array<{ appId: string; instruction: string; mode: string }> = [];
  const partial = {
    machine: { available: () => true },
    async create(input: Parameters<AppsRuntime["create"]>[0]) {
      if (work !== undefined) input.onServerWork?.(work);
      return {
        format: VENDO_APP_FORMAT,
        id: input.appId ?? "app_made",
        name: "Invoice nudges",
        ui: "tree" as const,
      };
    },
    automation: {
      async author(input: { appId: string; instruction: string; mode: string }) {
        asked.push(input);
        if (authored === undefined) throw new Error("no automations engine composed");
        return authored;
      },
    },
    async remember() {},
  };
  return { runtime: partial as unknown as AppsRuntime, asked };
};

const deps = {
  screen: { assemble: async () => ({ kind: "escalate" as const, why: "away work" }) },
  claimSlot: async () => {},
  markUnbuilt: async () => {},
} as unknown as AgentToolsDataDependencies;

/** The plain ask names no recurrence, so nothing reaches the automation door
 *  unless a case asks for it. */
const makeCall = (request = "make me an invoice board"): {
  call: VendoViewStreamingToolCall;
  updates: VendoViewStreamUpdate[];
} => {
  const updates: VendoViewStreamUpdate[] = [];
  const call: VendoViewStreamingToolCall = {
    id: "call_1",
    tool: "vendo_make",
    args: { request },
    [VENDO_VIEW_STREAM]: (update) => { updates.push(update); },
  };
  return { call, updates };
};

const receiptOf = (outcome: Awaited<ReturnType<typeof runMakeTool>>): { id: string; say: string; status: string } => {
  if (outcome.status !== "ok") throw new Error(`expected ok, got ${outcome.status}`);
  return outcome.output as unknown as { id: string; say: string; status: string };
};

/** The part, through the schema every downstream reader parses it with. */
const cardIn = (updates: VendoViewStreamUpdate[]): Record<string, unknown> => {
  const card = updates.find((update) => update.part.type === "data-vendo-automation");
  if (card === undefined) throw new Error("no automation card was published");
  const parsed = vendoAutomationPartSchema.safeParse(card.part);
  if (!parsed.success) throw new Error(`the card does not parse: ${parsed.error.message}`);
  expect(card.id).toBe(`vendo-automation-${parsed.data.automationId}`);
  return parsed.data as unknown as Record<string, unknown>;
};

describe("vendo_make publishes the automation card (#881)", () => {
  it("raises a card about the RECORD, humanized, that core's own schema accepts", async () => {
    const { call, updates } = makeCall();
    const { runtime } = runtimeWith({ automation: AUTOMATION });
    await runMakeTool(runtime, deps, call, ctx);

    expect(cardIn(updates)).toMatchObject({
      type: "data-vendo-automation",
      automationId: "atm_nudges",
      name: "Decide who deserves a nudge.",
      action: "Decide who deserves a nudge.",
      when: { kind: "schedule", every: "1d" },
      enabled: true,
    });
  });

  it("counts pending grants on the card", async () => {
    const { call, updates } = makeCall();
    const pendingGrants = [{}, {}] as unknown as NonNullable<NonNullable<CreateServerWork["automation"]>["pendingGrants"]>;
    const { runtime } = runtimeWith({ automation: { ...AUTOMATION, pendingGrants } });
    await runMakeTool(runtime, deps, call, ctx);

    expect(cardIn(updates).pendingGrants).toBe(2);
  });

  it("says when required server work could not be built, never a silent green receipt", async () => {
    const { call } = makeCall();
    const { runtime } = runtimeWith({ failed: ["the box did not produce a verified served web app"] });
    const outcome = await runMakeTool(runtime, deps, call, ctx);
    // The merged shape (#881 + upstream's partial-status receipt): the words
    // carry the reason AND the status branches — a reader that only checks
    // `status` no longer sees plain "ready" on a half-built app.
    const receipt = receiptOf(outcome);
    expect(receipt.say).toContain("didn't get built");
    expect(receipt.say).toContain("the box did not produce a verified served web app");
    expect(receipt.status).toBe("partial");
  });

  it("publishes no card and no caveat when the lane authored nothing", async () => {
    const { call, updates } = makeCall();
    const { runtime } = runtimeWith(undefined);
    const outcome = await runMakeTool(runtime, deps, call, ctx);
    expect(updates.some((update) => update.part.type === "data-vendo-automation")).toBe(false);
    expect(receiptOf(outcome).say).toBe("Invoice nudges is on your screen.");
  });
});

describe("the schedule half of a compound ask", () => {
  const COMPOUND = "build me the invoice board and refresh it every monday";

  it("reaches the automation door, and says so on the receipt", async () => {
    const { call, updates } = makeCall(COMPOUND);
    const { runtime, asked } = runtimeWith(undefined, {
      ok: true,
      document: { format: VENDO_APP_FORMAT, id: "app_made", name: "Invoice nudges" },
      record: RECORD,
      armed: true,
    });
    const outcome = await runMakeTool(runtime, deps, call, ctx);

    expect(asked).toEqual([{ appId: expect.stringMatching(/^app_/), instruction: COMPOUND, mode: "goal" }]);
    expect(receiptOf(outcome).say).toContain("It runs on the schedule you asked for.");
    expect(cardIn(updates).automationId).toBe("atm_nudges");
  });

  it("leaves an ask with no recurrence in it alone — no model call, no automation", async () => {
    const { call } = makeCall("show me every transaction from last month");
    const { runtime, asked } = runtimeWith(undefined);
    await runMakeTool(runtime, deps, call, ctx);

    expect(asked).toEqual([]);
  });

  it("never fails the make when the schedule could not be armed — the app is on screen", async () => {
    const { call, updates } = makeCall(COMPOUND);
    const { runtime } = runtimeWith(undefined, { ok: false, issues: ["no valid plan validated"] });
    const outcome = await runMakeTool(runtime, deps, call, ctx);

    const receipt = receiptOf(outcome);
    expect(receipt.status).toBe("ready");
    expect(receipt.say).toContain("I couldn't set up the schedule: no valid plan validated");
    expect(updates.some((update) => update.part.type === "data-vendo-automation")).toBe(false);
  });
});
