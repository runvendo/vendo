/**
 * 07-automations — the engine, and the one thing composition decides for it:
 * whether THIS process is the firing authority at all.
 */
import { awayRunner } from "@vendoai/agents";
import { createAutomations } from "@vendoai/automations";
import type { VendoComposition } from "./compose-context.js";
import { isHostedStore, reportHostedStoreOnce } from "./compose-store.js";
import { assembleSystemPrompt } from "./prompt.js";

/** How often a development process ticks its own scheduler. One minute is the
 *  engine's own `start()` default: fine-grained enough for the shortest real
 *  cadence people write ("every 5 minutes"), cheap enough to never matter. */
const DEV_TICK_INTERVAL_MS = 60_000;

const DEV_TICKER = Symbol.for("vendo.dev-automations-ticker");

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

/**
 * Which trigger kinds THIS process fires. `undefined` means every kind — the
 * engine's own default.
 *
 * Under the hosted store Cloud is the firing authority for schedule/external
 * — EXCEPT in development (field: linkwarden 2026-08-09): Cloud's scheduler
 * cannot reach a dev server (a localhost wire is in no deployment inventory),
 * so deferring to it armed schedules nobody would ever fire. A dev process
 * fires its own; the schedule-cursor claims are atomic in the shared store
 * (insertIfAbsent / compareAndSwap), so two firers can never double-run one
 * tick. An unmounted automations block never fires anything, whatever the
 * store — that is the same statement about this process either way.
 */
export function localFiringKinds(input: {
  hostedStoreComposed: boolean;
  automationsMounted: boolean;
  development: boolean;
}): Set<"schedule" | "external"> | undefined {
  if (!input.automationsMounted) return new Set();
  if (input.hostedStoreComposed && !input.development) return new Set();
  return undefined;
}

/** The automations engine, and the arming seam the apps runtime reads back. */
export const composeAutomations = (composition: VendoComposition): Pick<VendoComposition,
  "hostedStoreComposed" | "automations" | "automationsForArming" | "startDevAutomationsTicker"> => {
  const { store, ops, apps, boundTools, guard, harness, files, capability, inference } = composition;
  const { system, resolveRisk, access, membershipsSeam, automationsMounted } = composition;
  // The same derivation compose-wire's `development` uses: an explicit
  // config.development wins either way; otherwise NODE_ENV=development.
  const development = composition.config.development !== undefined
    ? composition.config.development !== false
    : composition.isDevelopmentEnv;
  // Wave 2 (Cloud auto): a keyed deployment's schedule- and external-triggered
  // automations already run on Vendo Cloud — its scheduler fires due schedules and
  // Composio delivers external events straight to Cloud. If this LOCAL engine also
  // fired them, a keyed deployment would double-run every automation. Under the hosted
  // store, Cloud is the firing authority for those two kinds; host-event automations
  // (vendo.emit) are untouched — they're invoked directly by this host process, not
  // scheduled or delivered, so there's nothing for Cloud to duplicate. One warn per
  // PROCESS (self-serve audit F7: a dev server recomposes on nearly every request,
  // so "once per composition" printed this paragraph 29 times in one short
  // session).
  const hostedStoreComposed = isHostedStore(store);
  if (hostedStoreComposed) reportHostedStoreOnce(development);
  const firingKinds = localFiringKinds({ hostedStoreComposed, automationsMounted, development });
  const automations = createAutomations({
    apps,
    tools: boundTools,
    guard,
    store,
    // The engine family for this block's own drawers, over the SAME store.
    // Absent for a store with neither its own ops nor a SQL handle — the block
    // then serves the same verbs off the adapter itself, so an unset slot is a
    // route, not a downgrade.
    ...(ops === undefined ? {} : { ops }),
    // An agentic firing is ONE non-interactive harness run on the deployment's
    // own brain — the same runtime, the same guard-bound choke point and the same
    // durable workspace a chat turn gets, with `interactive: false` and the
    // engine's fire-time ctx. The runner takes NO tool surface here: the engine
    // hands each run its own (`tools` above, projected for the firing ctx), which
    // is what keeps THE LAW's unattended filter in charge of what a model sees.
    runner: awayRunner({
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
    }),
    resolveRisk,
    // Build contract §9.3 — the fire-time sponsorship gate and the adoption
    // card ask `can(editor)` through this seam. Unwired it would silently fall
    // back to ownership and an editor-adopted automation would stop dead at its
    // next fire.
    appAccess: access,
    // Build contract §9.1 — an away run asserts the owner's orgs the same way a
    // request does; the callback is host server code in this deployment, so the
    // absence of a session is not in its way.
    ...(membershipsSeam === undefined ? {} : { memberships: membershipsSeam }),
    // Which kinds THIS process fires — see localFiringKinds above (Cloud is
    // the authority under the hosted store, except a development process,
    // which Cloud cannot reach and must fire its own schedules).
    ...(firingKinds === undefined ? {} : { localTriggerKinds: firingKinds }),
  });
  // A development process drives its own scheduler tick: the production tick
  // is an external caller's job (POST /tick with VENDO_TICK_SECRET, or Cloud
  // for hosted deploys), and no laptop has one — armed by the ready() latch
  // beside the background sweep, never at construction (timers are illegal in
  // Workers global scope). One ticker per PROCESS, adopted by the newest
  // composition (armDevTicker, #1250); the engine's interval is unref'd, so
  // it never keeps a dev server from exiting.
  const startDevAutomationsTicker = (): void => {
    if (!development || !automationsMounted) return;
    armDevTicker(() => automations.start(DEV_TICK_INTERVAL_MS));
  };
  return { hostedStoreComposed, automations, automationsForArming: automations, startDevAutomationsTicker };
};
