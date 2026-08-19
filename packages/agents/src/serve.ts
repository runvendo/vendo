/**
 * `serve({ agents })` — the lifecycle, and the moment a declaration starts
 * meaning something.
 *
 *     support.on("0 9 * * 1", "summarize the week and email ops");
 *     const runtime = await serve({ agents: [support] });
 *     await runtime.close();
 *
 * A trigger is INERT until this call. `.on()` validates and stashes; nothing is
 * written and nothing fires until a lifecycle reconciles it, so a process that
 * declares automations and starts neither this nor `createVendo` (whose boot
 * runs the same reconcile) simply has none.
 *
 * An assembler and nothing else — every mechanism below already exists. The
 * FIRST agent's composition is the deployment's: its store holds the records and
 * the run ledger, its guard audits them, its already-bound tools are what a
 * firing may reach. Every agent brings its own brain, registered under its own
 * name, because the name is what a declaration carries and what a firing looks
 * the brain up by.
 */
import { automationsInternals, createAutomations } from "@vendoai/automations";
import { VendoError, type Principal, type RunContext } from "@vendoai/core";
import { agentComposition, type AgentComposition, type VendoAgent } from "./agent.js";
import { agentAutomationPlan } from "./automations.js";
import { awayRunner } from "./away.js";

export interface ServeOptions {
  /** Whose declarations this process runs. */
  agents: readonly VendoAgent[];
}

export interface VendoRuntime {
  /** Stop the scheduler. The records stay in the store, armed — stopping a
   *  process is not a decision about what should fire. */
  close(): Promise<void>;
}

/** Who a CODE-authored automation belongs to. `.on()`'s consent is the code
 *  itself rather than any person's grant, so every declaration in a deployment
 *  shares ONE owner. Byte-identical to the umbrella's `CODE_AUTOMATION_OWNER`
 *  because the reconcile filters stored records on this subject: under a
 *  different one, `serve()` and `createVendo` could not see each other's records
 *  and each would disarm what the other armed. */
const OWNER: Principal = { kind: "user", subject: "vendo:code" };

/** Named rather than random so the audit trail of a redeploy's arm/disarm reads
 *  as one recurring act instead of a new stranger every deploy. */
const BOOT_RECONCILE_SESSION = "session_boot_reconcile";

const compositionOf = (agent: VendoAgent): AgentComposition => {
  const composed = agentComposition(agent);
  if (composed === undefined) {
    throw new VendoError(
      "validation",
      "serve({ agents }) takes the values `agent()` from @vendoai/agents returned, and one of them is something else — "
      + "pass `agent({ name, … })`'s return value, not a harness, a config object, or a class instance.",
    );
  }
  return composed;
};

export async function serve({ agents }: ServeOptions): Promise<VendoRuntime> {
  const composed = agents.map((agent) => [agent, compositionOf(agent)] as const);
  const primary = composed[0]?.[1];
  if (primary === undefined) {
    throw new VendoError(
      "validation",
      "serve({ agents }) needs at least one agent — pass the `agent({ name, … })` whose `.on()` declarations should run.",
    );
  }
  const engine = createAutomations({ tools: primary.tools, guard: primary.guard, store: primary.store });
  const internals = automationsInternals(engine);
  // By NAME, and only by name: every declaration carries its agent's own
  // (`declareAutomation`), so a firing needs no default brain to fall back to.
  // Two agents wearing one name throw HERE, at boot, rather than at 2am once the
  // wrong brain has already run.
  for (const [agent, composition] of composed) {
    // The brain is the agent's; the store, its blobs and the guard are the
    // DEPLOYMENT's — the half of the rule above that only the engine got. Left on
    // its own composition, a secondary parked its cards and wrote its threads into
    // its OWN store, where neither the run ledger naming the firing nor the mount a
    // person answers from can reach them.
    internals.runners.register(agent.name, awayRunner({ ...composition, store: primary.store, files: primary.files, guard: primary.guard }));
  }
  const ctx: RunContext = {
    principal: OWNER,
    venue: "automation",
    presence: "away",
    sessionId: BOOT_RECONCILE_SESSION,
  };
  await primary.store.ensureSchema();
  const stored = await engine.list({ owner: OWNER.subject }, ctx);
  // A failed reconcile REJECTS, where the umbrella's deliberately swallows: that
  // one rides a MEMOIZED ready() latch, so a rejection there is every route's
  // answer for the life of the process. This is an explicit awaited call with no
  // latch to poison, and a host that awaited `serve()` and got a runtime back has
  // to be able to trust that its triggers are armed.
  await internals.reconcile(agentAutomationPlan(agents, stored, OWNER), ctx);
  // The engine's own default cadence (one minute), its own unref'd interval and
  // its own stop function — a scheduler this process drives is not new machinery.
  const stop = engine.start();
  return { close: async () => stop() };
}
