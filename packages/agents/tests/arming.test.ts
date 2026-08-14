/**
 * `agent.arm()` — the ceremony that turns "let this run while I am away" into
 * standing authority: one ask per tool an unattended run could reach, and a yes
 * that mints the (app, trigger)-bound grant the firing runs on.
 *
 * Real embedded store, real guard, real approval wire — the guard IS the
 * counterparty here, so stubbing any of it would prove nothing (CLAUDE.md: test
 * the SEAM).
 */
import { createGuard, type VendoGuard } from "@vendoai/guard";
import { createStore, type VendoStore } from "@vendoai/store";
import { describe, expect, it } from "vitest";
import { agent, type VendoAgent } from "../src/agent.js";
import { tool } from "../src/tools.js";

let stores = 0;
const memoryStore = (): VendoStore => createStore({ dataDir: `memory://agents-arming-${stores++}` });

const principal = { kind: "user", subject: "u_owner" } as const;
const APP = "app_digest";

/** Two tools an away run may still reach, and two THE LAW withholds from every
 *  unattended run whatever anyone allows. */
const hostTools = () => [
  tool({ name: "invoices_list", description: "List invoices", risk: "read", inputSchema: { type: "object" }, execute: () => ({ invoices: 2 }) }),
  tool({ name: "invoices_email", description: "Email invoices", risk: "write", inputSchema: { type: "object" }, execute: () => ({ sent: true }) }),
  tool({ name: "invoices_delete", description: "Delete invoices", risk: "destructive", inputSchema: { type: "object" }, execute: () => ({ gone: true }) }),
  tool({ name: "invoices_guess", description: "Nobody graded this one", inputSchema: { type: "object" }, execute: () => ({}) }),
];

function compose(): { guard: VendoGuard; support: VendoAgent } {
  const store = memoryStore();
  const guard = createGuard({ store });
  return { guard, support: agent({ name: "support", tools: hostTools(), store, guard }) };
}

describe("arm() — the asks", () => {
  it("raises one ask per wanted tool, and reports the withheld ones instead of asking", async () => {
    const { guard, support } = compose();

    const result = await support.arm(principal.subject, { appId: APP, triggerId: "nightly" });

    expect([...result.held].sort()).toEqual(["invoices_delete", "invoices_guess"]);
    const pending = await guard.approvals.pending(principal);
    expect(pending.map((request) => request.call.tool).sort()).toEqual(["invoices_email", "invoices_list"]);
    expect(result.pending.sort()).toEqual(pending.map((request) => request.id).sort());
    // The ask is the FIRING's own ask — same app, same trigger, away — which is
    // what makes it worth answering.
    expect(pending[0]?.ctx).toMatchObject({
      venue: "automation",
      presence: "away",
      appId: APP,
      trigger: { id: "nightly" },
    });
  });

  it("asks only about the tools the caller named", async () => {
    const { guard, support } = compose();

    const result = await support.arm(principal.subject, { appId: APP, tools: ["invoices_list"] });

    expect(result.pending).toHaveLength(1);
    expect((await guard.approvals.pending(principal)).map((request) => request.call.tool))
      .toEqual(["invoices_list"]);
  });
});

describe("arm() — what a decision mints", () => {
  const armOne = async (): Promise<{ guard: VendoGuard; pending: string[] }> => {
    const { guard, support } = compose();
    const { pending } = await support.arm(principal.subject, {
      appId: APP,
      triggerId: "nightly",
      tools: ["invoices_list"],
    });
    return { guard, pending };
  };

  it("a yes mints a STANDING automation grant bound to (subject, appId, triggerId)", async () => {
    const { guard, pending } = await armOne();

    await guard.approvals.decide(pending, { approve: true }, principal);

    expect(await guard.grants.list(principal)).toMatchObject([{
      subject: "u_owner",
      tool: "invoices_list",
      appId: APP,
      triggerId: "nightly",
      source: "automation",
      duration: "standing",
      scope: { kind: "tool" },
    }]);
  });

  it("a no mints nothing", async () => {
    const { guard, pending } = await armOne();

    await guard.approvals.decide(pending, { approve: false }, principal);

    expect(await guard.grants.list(principal)).toEqual([]);
  });

  it("a take-back landing inside the decision arms nothing — the spend runs first", async () => {
    const store = memoryStore();
    const guard = createGuard({ store });
    // A competitor that takes the yes back the instant it lands, subscribed
    // BEFORE arming so it runs first: it claims the approval's one-time
    // transition, and the mint — which spends before it grants — finds nothing
    // left to spend. Mint-then-spend would have both winning.
    guard.onApprovalDecision(async (id) => {
      await guard.approvals.revoke(id, principal);
    });
    const support = agent({ name: "support", tools: hostTools(), store, guard });
    const { pending } = await support.arm(principal.subject, {
      appId: APP,
      triggerId: "nightly",
      tools: ["invoices_list"],
    });

    await guard.approvals.decide(pending, { approve: true }, principal);

    expect(await guard.grants.list(principal)).toEqual([]);
  });
});
