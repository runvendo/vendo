/**
 * ADVERSARIAL CHECK — `agent.arm()` against the OTHER subscriber on the same
 * guard.
 *
 * `createAutomations()` subscribes its own `onApprovalDecision` handler
 * (automations/src/engine.ts:24), and that handler claims ANY approved approval
 * whose context is `venue: "automation"` with an `appId` — which is exactly the
 * shape `arm()` raises (agents/src/arming.ts:82-89). Whichever subscriber
 * registered FIRST wins the approval's one-time `consumed` transition, so an
 * engine booted before the agent claims the ceremony's yes.
 *
 * The automations handler derives the trigger from the RUN ROW named by
 * `ctx.trigger.runId` (automations/src/consent.ts:221-224). `arm()` invents that
 * run id, so there is no row, so the trigger comes out `undefined` and the grant
 * is minted with NO `triggerId`.
 *
 * Both halves of the ceremony's promise then break, and one of them breaks OPEN:
 * the trigger the person armed holds nothing, and `main` — a trigger nobody was
 * ever shown — holds standing unattended authority.
 *
 * Nothing is stubbed: one real store, one real guard, the real engine, the real
 * ceremony (CLAUDE.md: test the SEAM).
 */
import { agent, tool, type VendoAgent } from "@vendoai/agents";
import type { AppsRuntime } from "@vendoai/apps";
import { createAutomations } from "@vendoai/automations";
import {
  DEFAULT_TRIGGER_ID,
  type AppId,
  type Principal,
  type RunContext,
  type RunId,
  type ToolRegistry,
} from "@vendoai/core";
import { createGuard, type VendoGuard } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import { describe, expect, it } from "vitest";

const principal: Principal = { kind: "user", subject: "u_owner" };
const APP = "app_digest";
const ARMED_TRIGGER = "nightly";

let stores = 0;

const invoicesList = tool({
  name: "invoices_list",
  description: "List invoices",
  risk: "read",
  inputSchema: { type: "object" },
  execute: () => ({ invoices: 2 }),
});

/** The realistic boot order: a host stands its automations engine up, then its
 *  agent, then a person arms a trigger. Nothing here is contrived — reverse the
 *  two constructor lines and the ceremony behaves; that ordering dependence is
 *  the defect. */
const bootEngineThenAgent = (): { guard: VendoGuard; support: VendoAgent } => {
  const store = createStore({ dataDir: `memory://vendo-arming-binding-${stores++}` });
  const guard = createGuard({ store });
  const registry: ToolRegistry = {
    descriptors: async () => [invoicesList.descriptor],
    execute: async (call, ctx) => ({ status: "ok", output: await invoicesList.execute(call.args, ctx, call) }),
  };
  createAutomations({
    apps: {} as unknown as AppsRuntime,
    guard,
    store,
    tools: guard.bind(registry),
  });
  const support = agent({ name: "support", store, guard, tools: [invoicesList] });
  return { guard, support };
};

const armAndSayYes = async (guard: VendoGuard, support: VendoAgent): Promise<void> => {
  const { pending } = await support.arm(principal.subject, {
    appId: APP,
    triggerId: ARMED_TRIGGER,
    tools: ["invoices_list"],
  });
  expect(pending).toHaveLength(1);
  await guard.approvals.decide(pending, { approve: true }, principal);
};

const awayCtx = (triggerId: string): RunContext => ({
  principal,
  venue: "automation",
  presence: "away",
  sessionId: "sess_check",
  appId: APP as AppId,
  trigger: { runId: `run_${triggerId}_check` as RunId, kind: "host-event", id: triggerId },
});

const call = { id: "call_check", tool: "invoices_list", args: {} };

describe("arm() binding, with an automations engine on the same guard", () => {
  it("mints a grant bound to the trigger the person armed", async () => {
    const { guard, support } = bootEngineThenAgent();

    await armAndSayYes(guard, support);

    expect(await guard.grants.list(principal)).toMatchObject([{
      subject: principal.subject,
      tool: "invoices_list",
      appId: APP,
      triggerId: ARMED_TRIGGER,
      source: "automation",
      duration: "standing",
    }]);
  });

  it("arms the trigger that was asked about", async () => {
    const { guard, support } = bootEngineThenAgent();

    await armAndSayYes(guard, support);

    // The trigger the person was shown: armed, so it runs unattended.
    const armed = await guard.previewCheck!(call, invoicesList.descriptor, awayCtx(ARMED_TRIGGER));
    expect({ action: armed.action, decidedBy: armed.decidedBy })
      .toEqual({ action: "run", decidedBy: "grant" });
  });

  it("arms NO OTHER trigger — `main` was never asked about", async () => {
    const { guard, support } = bootEngineThenAgent();

    await armAndSayYes(guard, support);

    // Nobody was ever shown a card for `main`. It must hold NOTHING — a "run"
    // here is standing unattended authority nobody consented to.
    const never = await guard.previewCheck!(call, invoicesList.descriptor, awayCtx(DEFAULT_TRIGGER_ID));
    expect({ action: never.action, decidedBy: never.decidedBy })
      .toEqual({ action: "ask", decidedBy: "default" });
  });
});
