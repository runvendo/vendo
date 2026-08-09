/**
 * 07-automations — the engine, and the one thing composition decides for it:
 * whether THIS process is the firing authority at all.
 */
import { awayRunner } from "@vendoai/agents";
import { createAutomations } from "@vendoai/automations";
import type { VendoComposition } from "./compose-context.js";
import { isHostedStore, reportHostedStoreOnce } from "./compose-store.js";
import { assembleSystemPrompt } from "./prompt.js";

/** The automations engine, and the arming seam the apps runtime reads back. */
export const composeAutomations = (composition: VendoComposition): Pick<VendoComposition,
  "hostedStoreComposed" | "automations" | "automationsForArming"> => {
  const { store, apps, boundTools, guard, harness, files, capability, inference } = composition;
  const { system, resolveRisk, access, membershipsSeam, automationsMounted } = composition;
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
  if (hostedStoreComposed) reportHostedStoreOnce();
  const automations = createAutomations({
    apps,
    tools: boundTools,
    guard,
    store,
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
    // Nothing fires locally when Cloud is already the firing authority for this
    // data — or when the host unmounted automations, which is the same
    // statement about this process: it is not the one that fires.
    ...(hostedStoreComposed || !automationsMounted
      ? { localTriggerKinds: new Set<"schedule" | "external">() }
      : {}),
  });
  return { hostedStoreComposed, automations, automationsForArming: automations };
};
