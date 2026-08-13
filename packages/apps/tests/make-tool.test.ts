/**
 * The receipt is words; the CARD is the envelope's surface (#881). When a
 * create rode its plan to an automation, `vendo_make` publishes the same
 * `data-vendo-automation` part the edit path has published since Wave 9 —
 * and required server work that could not be built rides the receipt's `say`
 * instead of dying in a server log.
 */
import {
  VENDO_APP_FORMAT,
  VENDO_VIEW_STREAM,
  type RunContext,
  type VendoViewStreamUpdate,
  type VendoViewStreamingToolCall,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import type { AgentToolsDataDependencies } from "../src/server/doors/agent-tools.js";
import { runMakeTool } from "../src/server/doors/make-tool.js";
import type { AppsRuntime, CreateServerWork } from "../src/server/runtime/types.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

const AUTOMATION: NonNullable<CreateServerWork["automation"]> = {
  mode: "agentic",
  trigger: {
    id: "trg_nudges",
    on: { kind: "schedule", every: "1d" },
    run: { kind: "agentic", prompt: "Decide who deserves a nudge.", budget: { maxToolCalls: 5 } },
  },
  enabled: true,
};

/** The one door under test is the PUBLICATION seam, so the runtime is a fake:
 *  a create that hands back whatever server-work outcome the case needs. */
const runtimeWith = (work: CreateServerWork | undefined): AppsRuntime => {
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
    async remember() {},
  };
  return partial as unknown as AppsRuntime;
};

const deps = {
  screen: { assemble: async () => ({ kind: "escalate" as const, why: "away work" }) },
  escalatedPlan: async () => `<Plan name="Invoice nudges"><Server kind="agentic" why="away work"/></Plan>`,
  claimSlot: async () => {},
  markUnbuilt: async () => {},
} as unknown as AgentToolsDataDependencies;

const makeCall = (): { call: VendoViewStreamingToolCall; updates: VendoViewStreamUpdate[] } => {
  const updates: VendoViewStreamUpdate[] = [];
  const call: VendoViewStreamingToolCall = {
    id: "call_1",
    tool: "vendo_make",
    args: { request: "nudge everyone with an overdue invoice every day" },
    [VENDO_VIEW_STREAM]: (update) => { updates.push(update); },
  };
  return { call, updates };
};

const receiptOf = (outcome: Awaited<ReturnType<typeof runMakeTool>>): { id: string; say: string; status: string } => {
  if (outcome.status !== "ok") throw new Error(`expected ok, got ${outcome.status}`);
  return outcome.output as unknown as { id: string; say: string; status: string };
};

describe("vendo_make publishes the create-path automation card (#881)", () => {
  it("raises data-vendo-automation for a create that authored an automation", async () => {
    const { call, updates } = makeCall();
    const outcome = await runMakeTool(runtimeWith({ automation: AUTOMATION }), deps, call, ctx);
    const { id } = receiptOf(outcome);
    const card = updates.find((update) => update.part.type === "data-vendo-automation");
    expect(card).toBeDefined();
    expect(card?.id).toBe(`vendo-automation-${id}`);
    expect(card?.part).toMatchObject({
      type: "data-vendo-automation",
      appId: id,
      name: "Invoice nudges",
      enabled: true,
    });
  });

  it("counts pending grants on the card", async () => {
    const { call, updates } = makeCall();
    const pendingGrants = [{}, {}] as unknown as NonNullable<NonNullable<CreateServerWork["automation"]>["pendingGrants"]>;
    await runMakeTool(runtimeWith({ automation: { ...AUTOMATION, pendingGrants } }), deps, call, ctx);
    const card = updates.find((update) => update.part.type === "data-vendo-automation");
    expect((card?.part as { pendingGrants?: number }).pendingGrants).toBe(2);
  });

  it("says when required server work could not be built, never a silent green receipt", async () => {
    const { call } = makeCall();
    const outcome = await runMakeTool(
      runtimeWith({ failed: ["the box did not produce a verified served web app"] }),
      deps, call, ctx,
    );
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
    const outcome = await runMakeTool(runtimeWith(undefined), deps, call, ctx);
    expect(updates.some((update) => update.part.type === "data-vendo-automation")).toBe(false);
    expect(receiptOf(outcome).say).toBe("Invoice nudges is on your screen.");
  });
});
