/**
 * ADVERSARIAL CHECK — is `held` honest?
 *
 * `arm()` promises: "Tools no unattended run may reach at all come back as
 * `held`, unasked" (agents/src/agent.ts:113-119). THE LAW an unattended run
 * actually runs under has three parts, all enforced in `guard.bind().execute()`
 * (guard.ts:793-796), and `held` is a lie unless it covers all three:
 *
 *   1. `withheldFromUnattended` on the descriptor — the grades §12 withholds.
 *   2. `presenceOnlyCall` — the pin/unpin tools are refused away by NAME, not by
 *      grade. `projectableForRun` drops them from every unattended listing.
 *   3. the EFFECTIVE risk — the guard re-grades a call through `resolveRisk`
 *      before it applies §12 (`completed.descriptor`), so a tool the host
 *      declared `write` and the deployment re-graded `destructive` is refused
 *      away. The declared grade alone would miss it.
 *
 * Miss any of them and `arm()` raises a card for something that can never run,
 * and a yes on that card mints STANDING authority for it.
 *
 * Real store, real guard, real ceremony — the guard IS the counterparty
 * (CLAUDE.md: test the SEAM).
 */
import { VENDO_APPS_PIN_TOOL, type RunContext } from "@vendoai/core";
import { createGuard, type VendoGuard } from "@vendoai/guard";
import { createStore, type VendoStore } from "@vendoai/store";
import { describe, expect, it } from "vitest";
import { agent, agentComposition, type VendoAgent } from "../src/agent.js";
import { tool } from "../src/tools.js";

let stores = 0;
const memoryStore = (): VendoStore => createStore({ dataDir: `memory://agents-held-${stores++}` });

const principal = { kind: "user", subject: "u_owner" } as const;
const APP = "app_digest";

const awayCtx: RunContext = {
  principal,
  venue: "automation",
  presence: "away",
  sessionId: "sess_check",
  appId: APP as RunContext["appId"],
  trigger: { runId: "run_check" as never, kind: "host-event", id: "nightly" },
};

/** Honestly `write` — putting your own app on your own page is a small
 *  reversible write with a person there. It is withheld away by NAME.
 *  `onRun` fires only if the host's own implementation is actually reached. */
const pinTool = (onRun: () => void = () => {}) => tool({
  name: VENDO_APPS_PIN_TOOL,
  description: "Pin this app to the page",
  risk: "write",
  inputSchema: { type: "object" },
  execute: () => {
    onRun();
    return { pinned: true };
  },
});

/** Declared `write`; this deployment re-grades it `destructive` at call time,
 *  which is the grade §12 is applied to. */
const emailTool = () => tool({
  name: "invoices_email",
  description: "Email invoices",
  risk: "write",
  inputSchema: { type: "object" },
  execute: () => ({ sent: true }),
});

const armAndSayYes = async (guard: VendoGuard, support: VendoAgent, name: string): Promise<string[]> => {
  const { pending, held } = await support.arm(principal.subject, {
    appId: APP,
    triggerId: "nightly",
    tools: [name],
  });
  if (pending.length > 0) await guard.approvals.decide(pending, { approve: true }, principal);
  return [...held];
};

describe("arm() — held is the whole law, or it is a lie", () => {
  it("holds the presence-only tools instead of asking about them", async () => {
    const store = memoryStore();
    const guard = createGuard({ store });
    const support = agent({ name: "support", tools: [pinTool()], store, guard });

    const held = await armAndSayYes(guard, support, VENDO_APPS_PIN_TOOL);

    expect(held).toEqual([VENDO_APPS_PIN_TOOL]);
  });

  it("mints no standing authority for a tool the away run is refused by name", async () => {
    const store = memoryStore();
    const guard = createGuard({ store });
    let ran = false;
    const support = agent({
      name: "support",
      tools: [pinTool(() => { ran = true; })],
      store,
      guard,
    });

    const { pending, held } = await support.arm(principal.subject, {
      appId: APP,
      triggerId: "nightly",
      tools: [VENDO_APPS_PIN_TOOL],
    });

    // Held means UNASKED: no ask came back, and none is sitting on the wire for
    // a person to answer. There is no card here for a yes to turn into standing
    // authority — which is the only way `held` can be honest about a tool the
    // away run is refused by name.
    expect([...held]).toEqual([VENDO_APPS_PIN_TOOL]);
    expect(pending).toEqual([]);
    expect(await guard.approvals.pending(principal)).toEqual([]);

    // And the away call itself still cannot happen. Holding the tool took the
    // grant away, so the call has no authority at all: it parks as an
    // unanswered question rather than reaching the host's implementation.
    const outcome = await agentComposition(support)!.tools.execute(
      { id: "call_pin", tool: VENDO_APPS_PIN_TOOL, args: {} },
      awayCtx,
    );
    expect(outcome.status).toBe("pending-approval");
    expect(ran).toBe(false);
    expect((await guard.grants.list(principal)).map((grant) => grant.tool)).toEqual([]);
  });

  it("holds a tool this deployment re-grades destructive, not the grade it was authored with", async () => {
    const store = memoryStore();
    const guard = createGuard({
      store,
      // The same seam the umbrella wires (`compose-guard.ts`): the grade a call
      // really runs under is resolved at call time, not read off the author's
      // label.
      resolveRisk: (call) => call.tool === "invoices_email" ? "destructive" : undefined,
    });
    const support = agent({ name: "support", tools: [emailTool()], store, guard });

    const held = await armAndSayYes(guard, support, "invoices_email");

    expect(held).toEqual(["invoices_email"]);
    expect((await guard.grants.list(principal)).map((grant) => grant.tool)).toEqual([]);
  });
});
