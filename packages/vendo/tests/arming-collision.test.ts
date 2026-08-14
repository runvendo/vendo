/**
 * ADVERSARIAL CHECK — two consent doors, two asks, ONE guard, and no
 * registration order to lean on.
 *
 * `createAutomations()` and `agent.arm()` both subscribe `onApprovalDecision` on
 * the same guard (automations/src/engine.ts:24, agents/src/arming.ts:71), and
 * the guard calls its subscribers in registration order. The fix for that
 * collision is a CAPTURE ROW: `arm()` writes one keyed by the approval it just
 * raised, which is the first branch the automations subscriber reads
 * (automations/src/consent.ts:168) — so whichever subscriber gets there first
 * uses the trigger the person was actually shown, and the loser finds the
 * approval's one-time transition already spent and mints nothing.
 *
 * That claim is only worth anything if it holds BOTH WAYS ROUND, so every case
 * here runs twice: engine constructed before the agent, and agent before the
 * engine. The two must be indistinguishable. And the two doors must not reach
 * into each other: arming's ask settles as arming's, the automations ask settles
 * as automations', whichever is answered first.
 *
 * Nothing is stubbed: one real store, one real guard, the real engine, the real
 * ceremony (CLAUDE.md: test the SEAM).
 */
import { agent, tool, type VendoAgent } from "@vendoai/agents";
import type { AppsRuntime } from "@vendoai/apps";
import { createAutomations, type AutomationsEngine } from "@vendoai/automations";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Principal,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { createGuard, type VendoGuard } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import { describe, expect, it } from "vitest";

const principal: Principal = { kind: "user", subject: "u_owner" };
const APP = "app_digest";
/** The trigger a person arms through `agent.arm()`. */
const ARMED_TRIGGER = "nightly";
/** A DIFFERENT trigger of the same app, armed through `automations.enable()` —
 *  so the two grants are told apart by the one field the collision destroyed. */
const AUTO_TRIGGER = "digest";

const presentCtx: RunContext = {
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "sess_enable",
};

let stores = 0;

const invoicesList = tool({
  name: "invoices_list",
  description: "List invoices",
  risk: "read",
  inputSchema: { type: "object" },
  execute: () => ({ invoices: 2 }),
});

const doc: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: APP,
  name: "Nightly digest",
  triggers: [{
    id: AUTO_TRIGGER,
    on: { kind: "host-event", event: "go" },
    run: { kind: "steps", steps: [{ id: "read", tool: invoicesList.descriptor.name }] },
  }],
};

type Order = "engine-first" | "agent-first";

interface Composition {
  guard: VendoGuard;
  support: VendoAgent;
  automations: AutomationsEngine;
}

/** The whole experiment: the ONLY difference between the two arms is which of
 *  the two constructors runs first, i.e. which subscriber the guard calls
 *  first. */
const boot = async (order: Order): Promise<Composition> => {
  const store = createStore({ dataDir: `memory://vendo-arming-collision-${stores++}` });
  const guard = createGuard({ store });
  const registry: ToolRegistry = {
    descriptors: async () => [invoicesList.descriptor],
    execute: async (call, ctx) => ({ status: "ok", output: await invoicesList.execute(call.args, ctx, call) }),
  };
  const mountEngine = (): AutomationsEngine => createAutomations({
    apps: {} as unknown as AppsRuntime,
    guard,
    store,
    tools: guard.bind(registry),
  });
  const mountAgent = (): VendoAgent => agent({ name: "support", store, guard, tools: [invoicesList] });
  let automations: AutomationsEngine;
  let support: VendoAgent;
  if (order === "engine-first") {
    automations = mountEngine();
    support = mountAgent();
  } else {
    support = mountAgent();
    automations = mountEngine();
  }
  await store.ensureSchema();
  await store.records("vendo_apps").put({
    id: APP,
    data: { subject: principal.subject, enabled: false, doc },
    refs: { subject: principal.subject },
  });
  return { guard, support, automations };
};

/** The ask the present-time ceremony raises for ARMED_TRIGGER. */
const armAsk = async (support: VendoAgent): Promise<string> => {
  const { pending } = await support.arm(principal.subject, {
    appId: APP,
    triggerId: ARMED_TRIGGER,
    tools: [invoicesList.descriptor.name],
  });
  expect(pending).toHaveLength(1);
  return pending[0]!;
};

/** The ask `enable()` captures for AUTO_TRIGGER. */
const enableAsk = async (automations: AutomationsEngine): Promise<string> => {
  const { missing } = await automations.enable(APP, AUTO_TRIGGER, presentCtx);
  expect(missing).toHaveLength(1);
  return missing[0]!.id;
};

const grantsBound = async (guard: VendoGuard): Promise<unknown[]> =>
  (await guard.grants.list(principal))
    .map((grant) => ({
      subject: grant.subject,
      tool: grant.tool,
      appId: grant.appId,
      triggerId: grant.triggerId,
      source: grant.source,
      duration: grant.duration,
    }))
    .sort((left, right) => String(left.triggerId).localeCompare(String(right.triggerId)));

const bound = (triggerId: string): unknown => ({
  subject: principal.subject,
  tool: invoicesList.descriptor.name,
  appId: APP,
  triggerId,
  source: "automation",
  duration: "standing",
});

const openAsks = async (guard: VendoGuard): Promise<string[]> =>
  (await guard.approvals.pending(principal)).map((request) => request.id);

for (const order of ["engine-first", "agent-first"] as const) {
  describe(`arm() and enable() on one guard — subscribers registered ${order}`, () => {
    it("arming's yes settles as ARMING's: bound to the trigger it asked about, nothing app-wide", async () => {
      const { guard, support, automations } = await boot(order);
      const arming = await armAsk(support);
      const engineSide = await enableAsk(automations);

      await guard.approvals.decide([arming], { approve: true }, principal);

      // ONE grant, bound to the trigger the person was actually shown. A row
      // with no triggerId is the defect this fix exists for: it is app-wide
      // standing unattended authority for triggers nobody was ever asked about.
      expect(await grantsBound(guard)).toEqual([bound(ARMED_TRIGGER)]);
      // And it did not reach into the other door's ask: still an open question.
      expect(await openAsks(guard)).toEqual([engineSide]);

      await guard.approvals.decide([engineSide], { approve: true }, principal);

      expect(await grantsBound(guard)).toEqual([bound(AUTO_TRIGGER), bound(ARMED_TRIGGER)]);
      // Read back through the path that actually gates a firing — the automations
      // half behaves exactly as it does today.
      expect((await automations.enable(APP, AUTO_TRIGGER, presentCtx)).missing).toEqual([]);
    });

    it("the automations yes settles as AUTOMATIONS' — arming neither claims, consumes, nor mints for it", async () => {
      const { guard, support, automations } = await boot(order);
      const arming = await armAsk(support);
      const engineSide = await enableAsk(automations);

      await guard.approvals.decide([engineSide], { approve: true }, principal);

      // Three failures are excluded at once. Had arming's listener MINTED for
      // this ask the row would name ARMED_TRIGGER; had it merely CONSUMED the
      // approval's one-time transition, automations would have found nothing
      // left to spend and there would be no row at all; had it CLAIMED the ask
      // without either, the read below would still be asking for consent.
      expect(await grantsBound(guard)).toEqual([bound(AUTO_TRIGGER)]);
      expect((await automations.enable(APP, AUTO_TRIGGER, presentCtx)).missing).toEqual([]);
      // Arming's own ask is untouched: still open, still unspent.
      expect(await openAsks(guard)).toEqual([arming]);

      await guard.approvals.decide([arming], { approve: true }, principal);

      expect(await grantsBound(guard)).toEqual([bound(AUTO_TRIGGER), bound(ARMED_TRIGGER)]);
    });
  });
}
