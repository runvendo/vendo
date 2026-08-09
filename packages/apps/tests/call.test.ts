import type { AppDocument, RunContext, ToolCall, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "../src/index.js";
import { guardFixture, memoryStore, seedAppRow } from "../src/testing/index.js";

// execution-v2 Wave 1.5 — the v1 MachineSessions fn: path is deleted. Until
// the in-runtime v2 fn path lands (fn/schedules lane), an fn: ref settles as a
// CONTAINED not-implemented outcome; host-tool refs ride the guard-bound
// registry unchanged. The wire-level v2 fn path (POST /apps/:appId/fn/:name →
// box door) is covered by the wire suites.

const context = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

const app = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Caller",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "Caller" } }],
  },
});

const setup = (tools?: ToolRegistry) => {
  const store = memoryStore();
  const runtime = createApps({
    store,
    guard: guardFixture(),
    tools: tools ?? {
      async descriptors() { return []; },
      async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
    },
    catalog: [],
  });
  return { store, runtime };
};

describe("app calls through createApps", () => {
  it("routes a host-tool ref to the guard-bound registry with app venue and app id", async () => {
    const calls: { call: ToolCall; ctx: RunContext }[] = [];
    const tools: ToolRegistry = {
      async descriptors() { return []; },
      async execute(call, runCtx) {
        calls.push({ call, ctx: runCtx });
        return { status: "ok", output: { echoed: call.args } };
      },
    };
    const { store, runtime } = setup(tools);
    await seedAppRow(store, app("app_host"), "user_ada");

    const outcome = await runtime.call("app_host", "host_invoices_list", { page: 1 }, context("user_ada"));

    expect(outcome).toEqual({ status: "ok", output: { echoed: { page: 1 } } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.call.tool).toBe("host_invoices_list");
    expect(calls[0]?.ctx.venue).toBe("app");
    expect(calls[0]?.ctx.appId).toBe("app_host");
  });

  it("settles an fn: ref on a machine-less app as a contained outcome, never a throw", async () => {
    // fn: refs on a MACHINE-BEARING app ride the box door (fn.ts suites);
    // this pins the base caller's fallthrough for an app that never graduated.
    const { store, runtime } = setup();
    await seedAppRow(store, app("app_fn"), "user_ada");

    const outcome = await runtime.call("app_fn", "fn:send_invoice", {}, context("user_ada"));

    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") throw new Error("unreachable");
    expect(outcome.error.code).toBe("validation");
    expect(outcome.error.message).toContain("requires a machine");
  });

  it("rejects a malformed fn name as a validation outcome", async () => {
    const { store, runtime } = setup();
    await seedAppRow(store, app("app_bad_fn"), "user_ada");

    const outcome = await runtime.call("app_bad_fn", "fn:bad name!", {}, context("user_ada"));

    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
  });

  it("scopes calls to the owner: a foreign principal sees not-found", async () => {
    const { store, runtime } = setup();
    await seedAppRow(store, app("app_owned"), "user_ada");

    await expect(
      runtime.call("app_owned", "host_anything", {}, context("user_bob")),
    ).rejects.toMatchObject({ code: "not-found" });
  });
});

// Re-gate 2026-07-26 I5-C (evidence PR #588): an island form fired
// host_transferMoney {amount: 25} — $0.25 — for a typed $25; the earlier
// H4-B fired 941220 for $2,850. The tool sketches say amounts are dollars or
// cents per host semantics, and the island seam had no unit check. The
// deterministic half lives here: a CENTS-classified input field (name ends
// in "cents", or the input schema's own description says cents/minor units)
// can never legally take a fractional number — that is a dollar amount, and
// it is rejected with a teaching error BEFORE the guard parks an approval
// the user could mistakenly approve.
describe("island/action amount unit guard", () => {
  const transferTools: ToolRegistry = {
    async descriptors() {
      return [
        {
          name: "host_transferMoney",
          description: "Send money. IRREVERSIBLY MOVES MONEY.",
          risk: "destructive" as const,
          inputSchema: {
            type: "object",
            required: ["amount", "recipient_name"],
            properties: {
              amount: { type: "integer", minimum: 1, description: "Amount to send in cents (positive whole number), e.g. 50000 = $500.00" },
              recipient_name: { type: "string" },
            },
          },
        },
        {
          name: "host_payDollars",
          description: "Pay a bill.",
          risk: "write" as const,
          inputSchema: {
            type: "object",
            properties: { amount: { type: "number", description: "Amount in dollars, e.g. 25.50" } },
          },
        },
        {
          name: "host_setBudget",
          description: "Set a budget threshold.",
          risk: "write" as const,
          inputSchema: {
            type: "object",
            properties: { amountCents: { type: "number" } },
          },
        },
        {
          name: "host_listRates",
          description: "List exchange rates.",
          risk: "read" as const,
          inputSchema: { type: "object", properties: { rate: { type: "number", description: "rate in cents" } } },
        },
      ];
    },
    async execute(call) {
      return { status: "ok", output: { ran: call.tool } };
    },
  };

  it("rejects a fractional value into a cents-described field with a teaching error", async () => {
    const { store, runtime } = setup(transferTools);
    await seedAppRow(store, app("app_units"), "user_ada");

    const outcome = await runtime.call(
      "app_units",
      "host_transferMoney",
      { amount: 28.5, recipient_name: "Mom" },
      context("user_ada"),
    );

    expect(outcome.status).toBe("error");
    if (outcome.status !== "error") throw new Error("unreachable");
    expect(outcome.error.code).toBe("validation");
    expect(outcome.error.message).toContain("integer cents");
    expect(outcome.error.message).toContain("amount");
  });

  it("rejects a fractional value into a *Cents-named field", async () => {
    const { store, runtime } = setup(transferTools);
    await seedAppRow(store, app("app_units2"), "user_ada");

    const outcome = await runtime.call("app_units2", "host_setBudget", { amountCents: 99.99 }, context("user_ada"));

    expect(outcome).toMatchObject({ status: "error", error: { code: "validation" } });
  });

  it("passes integer cents through untouched (the guard/approval pipe still gates)", async () => {
    const { store, runtime } = setup(transferTools);
    await seedAppRow(store, app("app_units3"), "user_ada");

    const outcome = await runtime.call(
      "app_units3",
      "host_transferMoney",
      { amount: 2500, recipient_name: "Mom" },
      context("user_ada"),
    );

    expect(outcome).toEqual({ status: "ok", output: { ran: "host_transferMoney" } });
  });

  it("leaves dollars-described fields and read tools alone", async () => {
    const { store, runtime } = setup(transferTools);
    await seedAppRow(store, app("app_units4"), "user_ada");

    await expect(
      runtime.call("app_units4", "host_payDollars", { amount: 25.5 }, context("user_ada")),
    ).resolves.toEqual({ status: "ok", output: { ran: "host_payDollars" } });
    await expect(
      runtime.call("app_units4", "host_listRates", { rate: 0.25 }, context("user_ada")),
    ).resolves.toEqual({ status: "ok", output: { ran: "host_listRates" } });
  });
});
