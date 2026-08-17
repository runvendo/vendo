/**
 * 07-automations — the engine, the named-runner map a firing looks its brain up
 * in, and the boot reconcile that turns `.on()` declarations into records.
 *
 * `@vendoai/agents` may not import `@vendoai/automations`, so `agent.on(...)`
 * only COLLECTS declarations. This is the one place they are executed: at boot
 * the umbrella reads what every agent collected, diffs it against what is
 * stored (core's shared reconcile, the same helper the manifest fold-in runs),
 * and drives the engine's create/disarm.
 */
import { agentAutomationPlan, agentComposition, awayRunner, type VendoAgent } from "@vendoai/agents";
import { automationsInternals, createAutomations } from "@vendoai/automations";
import {
  DEFAULT_RUNNER_NAME,
  isVendoError,
  log,
  VendoError,
  type AgentRunner,
  type Principal,
  type RunContext,
} from "@vendoai/core";
import type { VendoComposition } from "./compose-context.js";
import { cloudKeyOptions } from "./compose-selection.js";
import { isHostedStore, reportHostedStoreOnce } from "./compose-store.js";
import { assembleSystemPrompt } from "./prompt.js";
import { enrolForTicks } from "./tick-enrolment.js";

/** How often a development process ticks its own scheduler. One minute is the
 *  engine's own `start()` default: fine-grained enough for the shortest real
 *  cadence people write ("every 5 minutes"), cheap enough to never matter. */
const DEV_TICK_INTERVAL_MS = 60_000;

const DEV_TICKER = Symbol.for("vendo.dev-automations-ticker");

/** Who a CODE-authored automation belongs to. `.on()`'s consent is the code
 *  itself rather than any person's grant, so every declaration in a deployment
 *  shares ONE owner — which is also what lets a single reconcile disarm the
 *  automations of an agent that was dropped from `agents: []` altogether. */
export const CODE_AUTOMATION_OWNER: Principal = { kind: "user", subject: "vendo:code" };

/** The boot reconcile's session, named rather than random so the audit trail of a
 *  redeploy's arm/disarm reads as one recurring act instead of a new stranger
 *  every deploy. */
const BOOT_RECONCILE_SESSION = "session_boot_reconcile";

/** Arm the newest composition's dev ticker and retire the previous one —
 *  ADOPT, never duplicate (#1250). Next dev re-evaluates route modules on
 *  every recompile, and each evaluation builds a fresh composition whose
 *  closure guard (and module state) resets with it; after hours of
 *  recompiles a dev server carried dozens of live tickers, all sweeping the
 *  store every minute (field: linkwarden 2026-08-13). A boolean once-guard
 *  stopped the stacking but left the FIRST composition's ticker firing
 *  through a retired engine forever (PR #1254 review) — so arming stops the
 *  predecessor's interval (the engine's own `start()` hands back its stop)
 *  and starts the newcomer's, keeping exactly one ticker, bound to the
 *  composition actually serving requests. The slot rides globalThis via
 *  Symbol.for so it survives module re-evaluation. */
export function armDevTicker(start: () => () => void, host: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>): void {
  const previousStop = host[DEV_TICKER];
  if (typeof previousStop === "function") (previousStop as () => void)();
  host[DEV_TICKER] = start();
}

/** The automations engine, the create seam the apps doors author through, and
 *  the boot reconcile the ready() latch drives. */
export const composeAutomations = (composition: VendoComposition): Pick<VendoComposition,
  "hostedStoreComposed" | "automations" | "createAutomation" | "bootReconcile"
  | "startDevAutomationsTicker" | "enrolForCloudTicks"> => {
  const { store, ops, boundTools, guard, harness, files, capability, inference } = composition;
  const { system, resolveRisk, membershipsSeam, automationsMounted, config } = composition;
  // The same derivation compose-wire's `development` uses: an explicit
  // config.development wins either way; otherwise NODE_ENV=development.
  const development = composition.config.development !== undefined
    ? composition.config.development !== false
    : composition.isDevelopmentEnv;
  // One warn per PROCESS (self-serve audit F7: a dev server recomposes on
  // nearly every request, so "once per composition" printed this paragraph 29
  // times in one short session).
  const hostedStoreComposed = isHostedStore(store);
  if (hostedStoreComposed) reportHostedStoreOnce();
  // An agentic firing is ONE non-interactive harness run on the deployment's
  // own brain — the same runtime, the same guard-bound choke point and the same
  // durable workspace a chat turn gets, with `interactive: false` and the
  // engine's fire-time ctx. The runner takes NO tool surface here: the engine
  // hands each run its own (`tools` below, projected for the firing ctx), which
  // is what keeps THE LAW's unattended filter in charge of what a model sees.
  const composedRunner = awayRunner({
    harness,
    store,
    files,
    guard,
    skills: capability.skills,
    models: inference.seats,
    // The SAME brief a chat turn thinks on, assembled for the FIRING ctx — so
    // the venue gate and the guard's directions are the away run's too, and the
    // deployment does not have two agents wearing one name. No discovery
    // section: an away run gets no discovery rails, and promising `find_tools`
    // would name a tool that is not on its listing.
    system: (ctx) => assembleSystemPrompt(guard, ctx, system, true, false),
  });
  const automations = createAutomations({
    tools: boundTools,
    guard,
    store,
    // The engine family for this block's own drawers, over the SAME store.
    // Absent for a store with neither its own ops nor a SQL handle — the block
    // then serves the same verbs off the adapter itself, so an unset slot is a
    // route, not a downgrade.
    ...(ops === undefined ? {} : { ops }),
    resolveRisk,
    // Build contract §9.1 — an away run asserts the owner's orgs the same way a
    // request does; the callback is host server code in this deployment, so the
    // absence of a session is not in its way.
    ...(membershipsSeam === undefined ? {} : { memberships: membershipsSeam }),
  });
  const internals = automationsInternals(automations);
  /** Every agent whose `.on()` declarations this deployment carries: the one it
   *  ADOPTED, then the ones it merely names. */
  const declaringAgents = [config.agent, ...(config.agents ?? [])]
    .filter((agent): agent is VendoAgent => agent !== undefined);
  // Every agent a firing can name, by NAME, decided at BOOT. The composed agent
  // answers to DEFAULT_RUNNER_NAME; `createVendo({ agent })` is that same brain,
  // so its own name reaches the SAME runner rather than a second one, and each
  // agent in `agents: []` brings its own. A duplicate name throws HERE rather
  // than at 2am, when a firing that looked one up would get the wrong brain.
  internals.runners.register(DEFAULT_RUNNER_NAME, composedRunner);
  if (config.agent !== undefined && config.agent.name !== DEFAULT_RUNNER_NAME) {
    internals.runners.register(config.agent.name, composedRunner);
  }
  for (const extra of config.agents ?? []) {
    internals.runners.register(extra.name, extraAgentRunner(extra));
  }
  // Runs on the ready() latch, after ensureSchema and before the first request
  // is served — `.on()` collects at module load, so this is the first moment the
  // whole set is known AND the store can be written. Unconditional: a deployment
  // that just DELETED its last `.on()` still has stragglers to disarm, so an
  // empty declaration set is a reconcile too.
  const bootReconcile = async (): Promise<void> => {
    if (!automationsMounted) return;
    const ctx: RunContext = {
      principal: CODE_AUTOMATION_OWNER,
      venue: "automation",
      presence: "away",
      sessionId: BOOT_RECONCILE_SESSION,
    };
    try {
      const stored = await automations.list({ owner: CODE_AUTOMATION_OWNER.subject }, ctx);
      const plan = agentAutomationPlan(declaringAgents, stored, CODE_AUTOMATION_OWNER);
      // The applier, NOT `disable`: `disable` is the PERSON's kill switch and
      // stamps `disarmedBy: "user"`, which a redeploy has no business
      // impersonating — and `reconcile` skips every record already carrying that
      // stamp, which is what makes a switch a human set survive every deploy.
      // Two disarm reasons, one `armed` flag; the stamp is the whole distinction.
      await internals.reconcile(plan, ctx);
      if (plan.create.length > 0 || plan.disarm.length > 0) {
        log({
          code: "vendo.automations-reconciled",
          level: "info",
          message: `[vendo] reconciled code-authored automations: ${plan.create.length} armed, ${plan.disarm.length} disarmed.`,
        });
      }
    } catch (error) {
      // THE RECONCILE IS NOT THE DEPLOYMENT. It rides the ready() latch, and the
      // latch is MEMOIZED: a rejection here is every route's answer for the life
      // of the process. 0.27.0 shipped that — a hosted store whose engine
      // allowlist did not carry `vendo_automations` refused the boot read, and
      // deployments that never touched an automation served 501 to everything.
      // Code-authored automations are one feature; the rest of the product does
      // not wait on them. Scoped to THIS read: every per-request store failure
      // beyond it still fails in the open, where the caller can see it.
      const refused = isVendoError(error);
      log({
        code: "vendo.automations-reconcile-skipped",
        level: refused ? "warn" : "error",
        message: refused
          ? "[vendo] Vendo Cloud hasn't enabled the automations store yet — code-authored automations stay off until it does; everything else serves."
          : "[vendo] the code-authored automations could not be reconciled at boot; they stay off and everything else serves:",
        data: { error },
      });
    }
  };
  // A development process drives its own scheduler tick: production is woken by
  // an external caller (POST /tick — the host's own cron, or Vendo Cloud's
  // heartbeat), and no laptop has one — armed by the ready() latch beside the
  // background sweep, never at construction (timers are illegal in Workers
  // global scope). One ticker per PROCESS, adopted by the newest composition
  // (armDevTicker, #1250); the engine's interval is unref'd, so it never keeps
  // a dev server from exiting.
  const startDevAutomationsTicker = (): void => {
    if (!development || !automationsMounted) return;
    armDevTicker(() => automations.start(DEV_TICK_INTERVAL_MS));
  };
  // The DEPLOYED half of the same story: Cloud's heartbeat is what wakes a hosted
  // deployment, and it can only knock on a door it has been told about. Nothing is
  // configured — the secret is derived from the Cloud key this process already has
  // — and enrolment is idempotent on (project, host), so every boot of every
  // replica calling it is the intended usage. Fired from the ready() latch like
  // the ticker; every condition and every failure lives in enrolForTicks.
  const enrolForCloudTicks = (): Promise<void> => enrolForTicks({
    cloud: cloudKeyOptions(),
    automationsMounted,
    development,
    publicUrl: composition.urls?.publicUrl,
  });
  return {
    hostedStoreComposed,
    automations,
    createAutomation: internals.create,
    bootReconcile,
    startDevAutomationsTicker,
    enrolForCloudTicks,
  };
};

/** An agent from `agents: []` fires through its OWN composition — its harness,
 *  its voice, its skills. That is what naming a second agent is for; the tool
 *  surface is still the engine's, projected for the firing ctx. */
function extraAgentRunner(agent: VendoAgent): AgentRunner {
  const composed = agentComposition(agent);
  if (composed === undefined) {
    throw new VendoError(
      "validation",
      "createVendo({ agents }) takes the values `agent()` from @vendoai/agents returned, and one of them is something else — "
      + "pass `agent({ name, … })`'s return value, not a harness, a config object, or a class instance.",
    );
  }
  return awayRunner(composed);
}
