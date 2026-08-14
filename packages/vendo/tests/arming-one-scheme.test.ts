/**
 * ONE SCHEME for a standing automation grant, proved across the two blocks that
 * mint and read it.
 *
 * `agent.arm()` (agents) writes the grant through the guard's own mint; the
 * automations engine reads it back through `liveAutomationGrants` — the read
 * behind `dryRun`'s "does this trigger already hold what it needs". BOTH halves
 * are real here, over one store: the grant is minted by a real ceremony and read
 * by the real engine, with nothing stubbed on either side. Mock either one and
 * they could never disagree — which is exactly how a dead feature ships green
 * (CLAUDE.md: test the SEAM).
 *
 * The engine is stood up BEFORE the ceremony runs, which is the order a host
 * boots in — and the order that matters, because both blocks subscribe to the
 * same guard's decisions and the engine's subscriber is then the first to see
 * the person's yes.
 *
 * The one thing that is not real is the `apps` runtime the engine takes: `dryRun`
 * never reaches it, and it is no part of this seam.
 */
import { createAutomations } from "@vendoai/automations";
import { agent, tool } from "@vendoai/agents";
import type { AppsRuntime } from "@vendoai/apps";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Principal,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import { describe, expect, it } from "vitest";

const principal: Principal = { kind: "user", subject: "u_owner" };
const ctx: RunContext = { principal, venue: "automation", presence: "present", sessionId: "sess_check" };
const APP = "app_digest";

/** Two triggers, one step each: the one the person arms, and a sibling nobody
 *  armed — the control that keeps the assertion below from being vacuous. */
const doc: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: APP,
  name: "Invoice digest",
  triggers: ["nightly", "weekly"].map((id) => ({
    id,
    on: { kind: "host-event" as const, event: "go" },
    run: { kind: "steps" as const, steps: [{ id: "read", tool: "invoices_list" }] },
  })),
};

describe("a grant armed through agents is the grant automations reads", () => {
  it("leaves the armed trigger nothing missing, and the sibling everything", async () => {
    const store = createStore({ dataDir: "memory://vendo-arming-one-scheme" });
    const guard = createGuard({ store });
    const invoicesList = tool({
      name: "invoices_list",
      description: "List invoices",
      risk: "read",
      inputSchema: { type: "object" },
      execute: () => ({ invoices: 2 }),
    });
    const registry: ToolRegistry = {
      descriptors: async () => [invoicesList.descriptor],
      execute: async (call, runCtx) =>
        ({ status: "ok", output: await invoicesList.execute(call.args, runCtx, call) }),
    };
    // The host's own boot order: the engine first, then the agent — so the
    // engine's decision subscriber is the one that sees the yes first.
    const engine = createAutomations({
      apps: {} as unknown as AppsRuntime,
      guard,
      store,
      tools: guard.bind(registry),
    });
    const support = agent({ name: "support", store, guard, tools: [invoicesList] });

    // THE WRITE PATH: the person arms one trigger and says yes.
    const { pending } = await support.arm(principal.subject, { appId: APP, triggerId: "nightly" });
    await guard.approvals.decide(pending, { approve: true }, principal);

    // THE READ PATH: the engine's own preview, over the same store and the same
    // guard binding over the same tool the ceremony asked about.
    await store.records("vendo_apps").put({
      id: APP,
      data: { subject: principal.subject, enabled: true, doc },
      refs: { subject: principal.subject },
    });

    expect(await engine.dryRun(APP, "nightly", ctx)).toEqual({
      steps: [{ id: "read", tool: "invoices_list", wouldAsk: false }],
      grantsMissing: [],
    });
    expect(await engine.dryRun(APP, "weekly", ctx)).toEqual({
      steps: [{ id: "read", tool: "invoices_list", wouldAsk: true }],
      grantsMissing: ["invoices_list"],
    });
  });
});
