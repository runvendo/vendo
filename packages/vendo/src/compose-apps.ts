/**
 * 06-apps — the app generation runtime, and every seam only a composition can
 * fill: the box's env and inference door, the multi-party Cloud gate, the
 * cross-subject promote door, the screen agent in front of the conductor, and
 * the arming seam onto the automations engine composed after it.
 */
import {
  createApps,
  SCREEN_FILE,
  type AppsConfig,
} from "@vendoai/apps";
import { unattendedIrreversibilityCheck } from "@vendoai/automations";
import { inferenceEnv } from "@vendoai/harnesses/claude-code/box";
import { appBuilder } from "./build-agent.js";
import { screenAssembler } from "./screen-agent.js";
import {
  VendoError,
  type AppId,
  type Json,
  type RunContext,
  type WorkspaceFs,
} from "@vendoai/core";
import { appAccess } from "@vendoai/store";
import { askUserRegistry } from "./ask-user.js";
import { cloudApps } from "./cloud-apps.js";
import { cloudKeyOptions } from "./compose-selection.js";
import type { VendoComposition } from "./compose-context.js";
import { vendoVerbsRegistry } from "./vendo-verbs.js";
import { environment } from "./wire/shared.js";

/** The seams composition assembles for the apps runtime, in the order the one
 *  function assembled them (the env knobs THROW on a typo, so they are read
 *  where they were read). */
interface AppsSeams {
  boxTemplate: string | undefined;
  appsCloud: ReturnType<typeof cloudKeyOptions>;
  screenWorkspace: (screenCtx: RunContext) => Promise<WorkspaceFs>;
  access: ReturnType<typeof appAccess>;
}

/** Persistence, permission and interchange: the seams the runtime reads and
 *  writes THROUGH. */
const appsStoreSeams = (composition: VendoComposition, seams: AppsSeams): Partial<AppsConfig> => {
  const { store, ops, guard, boundTools, inference, catalog, seedBaselines, files } = composition;
  const { access } = seams;
  return {
    store,
    // Adapter rule — the SAME ops surface the deployment selected, so app data
    // lands owner-stamped through the named-operation family instead of the
    // raw façade.
    ops,
    guard,
    tools: boundTools,
    model: inference.agent.model,
    // The AI reviewer's own seat — the FAST pick. `review` resolves through the
    // family fast path (`resolveModels`: its own rung pick when the default rode
    // the ladder, else the default itself), so a deployment with a fast model
    // reviews on it and one without keeps reviewing on the flagship. Judging a
    // finished screen against its own rows is a reading job; it was paying
    // flagship rates for it.
    reviewModel: inference.seats.review,
    catalog,
    seedBaselines,
    // Contract §3.2 — the SAME `FilesAdapter` the workspace rows spill to (one
    // `selectFiles` answer, above), so an app's source past the inline cap uses the
    // spill that already exists instead of inventing a second one.
    files,
    // Build contract §9 — `can()` over whatever store the host wired (OSS,
    // unconditional). (§9.1's `memberships` left this seam with the
    // machine-app scheduler: the ONE unattended firing path is the automations
    // engine, which is handed the same seam below.)
    appAccess: access,
  };
};

/** THE SEAM (blueprint §1 point 2) — the screen agent in front of the
 *  conductor, joined here because composition is what holds every half. */
const appsScreenSeam = (
  composition: VendoComposition,
  seams: AppsSeams,
  build: NonNullable<AppsConfig["build"]>,
): AppsConfig["screen"] => {
  const { inference, boundTools, briefing } = composition;
  const { screenWorkspace } = seams;
  return screenAssembler({
      // The door out, from the very thing that would have to honour it: the
      // loop is offered `escalate` only where a box can really be claimed after
      // the person's yes, so an escalation never ends in "no build machine".
      canBuild: build.available,
      // The SAME seats every other thinker runs on.
      models: inference.seats,
      // The SAME guard-bound registry. There is no second choke point.
      tools: boundTools,
      workspace: screenWorkspace,
      // A remix starts as the host's PORTED component, already stored on the
      // row. The agent checks it out before its first edit, so the model edits
      // that code instead of writing a replacement from nothing.
      //
      // A REMIX AND NOTHING ELSE — `seed` is what says the row holds source the
      // loop did not write. An ordinary app's edit keeps starting from whatever
      // its workspace already holds, exactly as it did before this slot existed;
      // widening the checkout to every app is a change to every edit, and this
      // is not the change that earns it.
      storedScreen: async (appId, screenCtx) => {
        const document = await composition.apps.get(appId, screenCtx);
        return document?.seed === undefined ? undefined : document.source?.[SCREEN_FILE]?.text;
      },
      // A RE-SEED's replay starts from the host's NEW port, published by
      // `reseed` for that replay only and gone once read. An ordinary edit
      // publishes nothing, so it can never take one.
      replayFrom: (appId) => composition.apps.takeReplaySource(appId),
      // The SAME seam options the harness turns pass below — every one of them,
      // because a screen assembled here lands on the same store through the same
      // `commit()`. §3.2's source half and §7.1's floor — the gauntlet's own
      // `ok` is what upserts the row, so a screen the floor refused is never an
      // app. One seam cannot have two answers about the same bytes.
      render: (screenCtx) => ({
        commitSource: (input) => composition.apps.commitSource(input, screenCtx),
        floor: composition.apps.floor(screenCtx),
      }),
      // The app's memory, through the runtime's one write door — the same door
      // the front door records asks with. Nothing in this package decides what
      // goes in it; the assembler hands over the agent's own words.
      remember: async (appId, decisions, memoryCtx) => {
        await composition.apps.remember({ appId, decisions }, memoryCtx);
      },
      // The deployment's CONVERSATIONAL prompt is deliberately unset: voice, the
      // venue gate, guard directions and the discovery rail belong to the thinker
      // talking to the PERSON, and this loop talks to nobody — the front door
      // speaks its one-line receipt.
      //
      // What a writer does need is the host's own configuration, and it arrives
      // as ONE briefing pack (compose-surfaces.ts) — theme tokens, design rules,
      // the product brief, the component catalog and the semantics-annotated
      // tool SHAPE CARD. It used to arrive on two slots with two owners, and the
      // second rung got neither: the in-box builder was told nothing about the
      // brand, and `.vendo/brief.md` reached no writer at all. One assembly, both
      // rungs, same bytes — the instructions around it stay per-rung.
      briefing,
  });
};

/** THE OTHER SEAM — the build lane behind the escalations the screen agent
 *  refuses, joined here for the same reason and on the same terms. */
const appsBuildSeam = (composition: VendoComposition, seams: AppsSeams): NonNullable<AppsConfig["build"]> =>
  appBuilder({
    sandbox: composition.sandbox.adapter,
    // The SAME env a session box gets. A build box holds ZERO store
    // credentials (FINAL SPEC v1): it returns files, and the host seals them.
    boxEnv: inferenceEnv,
    // …and the SAME briefing pack the screen agent above is handed: this rung
    // writes for the same product, so it is told about it in the same bytes.
    briefing: composition.briefing,
    ...(seams.boxTemplate === undefined ? {} : { template: seams.boxTemplate }),
  });

/** The host's own knobs and the config-surface providers. */
const appsTailSeams = (composition: VendoComposition, seams: AppsSeams): Partial<AppsConfig> => {
  const { config, automationsMounted, themeProvider, briefing, hostSemanticsProvider } = composition;
  const { secrets } = composition;
  const { appsCloud } = seams;
  return {
    // The four verbs this block may ask of the automations engine: THE one create
    // operation (`vendo_automate`, `vendo_make`'s auto-arm sugar, the vendo.json
    // fold-in), the arm/disarm pair, and the resolve an app page reads its own
    // `automations: string[]` with. Every one is late-bound, as `armAutomation`
    // was: automations is constructed AFTER apps, and every call happens inside a
    // request. Absent when the engine is unmounted, so a deployment that turned
    // automations off is not offered an authoring door that could never fire —
    // the same reason `vendo.emit` refuses there.
    ...(automationsMounted ? {
      automations: {
        create: async (input, createCtx) => {
          const create = composition.createAutomation;
          if (create === undefined) {
            throw new VendoError("not-implemented", "the automations engine is not composed yet");
          }
          return create(input, createCtx);
        },
        enable: async (id, ctx, options) => composition.automations.enable(id, ctx, options),
        disable: async (id, ctx) => composition.automations.disable(id, ctx),
        // A list of NAMES, not foreign keys: an id nothing answers for is dropped
        // rather than raised, so deleting an automation is one fewer entry the
        // next time the app is read.
        resolve: async (ids, ctx) => (await Promise.all(
          ids.map(async (id) => composition.automations.get(id, ctx)),
        )).filter((record) => record !== null),
      },
    } : {}),
    ...(config.apps?.pipeline === undefined ? {} : { pipeline: config.apps.pipeline }),
    // The SAME registry `<VendoProvider routes>` renders against, for the floor:
    // a screen that names a page this host never registered is refused where it
    // can still be repaired, not left to render as dead text.
    ...(config.routes === undefined ? {} : { routes: config.routes }),
    // The floor's plugged checks: the host's own, then the ones a mounted
    // subsystem brings. Appended, never replacing — and a judgment rule rides
    // along here too, which the floor splits out into the reviewer's rubric
    // rather than running.
    checks: [
      ...(config.apps?.checks ?? []),
      ...(automationsMounted ? [unattendedIrreversibilityCheck] : []),
    ],
    // cse lane 3 — theme/semantics flow as PROVIDER thunks so a
    // cloud-owned surface applies without a compose-time fetch. semantics
    // resolves live per generation (picks up cloud overrides as the snapshot warms);
    // theme is boot-once via memoizeOnce (structural, next-load). Each returns
    // undefined when unset, which the engine treats exactly as an omitted value.
    // `theme` here is the SERVED-app handoff (the `?vendoTheme=` query param);
    // what a writer is told about the brand rides the briefing pack below.
    theme: themeProvider,
    // THE briefing pack, in the same bytes the screen agent above is handed.
    briefing,
    ...(appsCloud === undefined ? {} : { cloud: cloudApps(appsCloud) }),
    semantics: hostSemanticsProvider,
    secrets,
  };
};

/** 06-apps §1 — the app runtime, and the three registries that join the ONE
 *  tool registry the moment it exists. */
export const composeApps = (composition: VendoComposition): Pick<VendoComposition,
  "access" | "apps" | "appsRuntime" | "resolveAppToolRisk"> => {
  const { store, actions, capability } = composition;
  const boxTemplate = environment("VENDO_BOX_TEMPLATE");
  // ADAPTER RULE, share/publish seam: the apps block never reads the
  // environment — VENDO_API_KEY fills its CloudAppsClient slot HERE, at the
  // composition seam; unfilled, share/publish refuse with cloud-required.
  const appsCloud = cloudKeyOptions();
  // `composition.createAutomation` is the authoring seam the apps doors write
  // through: filled with the automations engine composed BELOW (authoring only
  // happens inside requests, which run after createVendo returns, so the closure
  // reference is safe — same pattern as the connections
  // loadout seed). `composition.harnessTurnsForScreens` is the screen agent's
  // workspace door, on the same late binding and safe for the same reason. It is
  // the PUBLIC door (`harnessTurns.workspace`) rather than a second
  // `workspaceStore` call, so a screen agent writes through the exact mount set
  // — `/host` projection and asserted orgs included — that a harness turn's own
  // hands write through.
  /** That door, opened for one ctx. ONE spelling, because the assembler that
   *  WRITES the escalated plan and the receiving end that READS it back must be
   *  looking at the same mount set or the plan is simply not there. */
  const screenWorkspace = async (screenCtx: RunContext): Promise<WorkspaceFs> => {
    const harnessTurnsForScreens = composition.harnessTurnsForScreens;
    if (harnessTurnsForScreens === undefined) {
      throw new VendoError("not-implemented", "the harness turn door is not composed yet");
    }
    return await harnessTurnsForScreens.workspace(
      screenCtx.principal,
      screenCtx.memberships === undefined ? undefined : { memberships: screenCtx.memberships },
    );
  };
  const access = appAccess(store);
  const seams: AppsSeams = {
    boxTemplate,
    appsCloud,
    screenWorkspace,
    access,
  };
  const build = appsBuildSeam(composition, seams);
  const apps = createApps({
    ...appsStoreSeams(composition, seams),
    screen: appsScreenSeam(composition, seams, build),
    build,
    ...appsTailSeams(composition, seams),
  } as AppsConfig);
  // Every contributed tool reaches the ONE registry here — the same `add` the
  // app tools used to arrive through directly, so they are guarded, audited,
  // and projected identically to a host tool.
  actions.add(capability.tools);
  // Design §4's vendo verbs, projected onto the SAME registry as everything else
  // — guarded, audited, and searchable by `find_tools`, with no privileged side
  // door. `records_list/put/delete` are deliberately absent: they already ship as
  // `vendo_apps_data_*` through the apps pack, and those names are written inside
  // stored app documents (contract §8's lane-D ratification — renaming would
  // invalidate live apps for cosmetics).
  //
  // The building-apps skill teaches `validate` BY NAME, and a skill body is
  // copied to a harness verbatim rather than translated, so this name has to
  // resolve or the skill points the model at a tool that does not exist.
  // Design §4's one door for questions, on the same registry as everything else,
  // so the guard, the audit trail and `find_tools` see it like any host tool. A
  // question is TURN-ENDING (build contract §8 cuts steering): the door records
  // the question, the loop stops, and the answer arrives as the next turn's
  // message — so it needs no thread binding, no answer door and no surface.
  actions.add(askUserRegistry());
  actions.add(vendoVerbsRegistry({
    // The ctx is the CALLER's, handed down by the registry's own `execute` — not
    // assembled here and never read off the model's input. Both app-touching
    // verbs are owner-scoped behind it.
    validate: (input, ctx) => apps.validate(
      input.appId === undefined
        ? {}
        : {
            appId: input.appId as AppId,
            ...(input.request === undefined ? {} : { request: input.request }),
            ...(input.viewport === undefined ? {} : { viewport: input.viewport }),
          },
      ctx,
    ),
    schedule: async ({ appId, cron }, ctx) =>
      await apps.schedule(appId as AppId, cron, ctx) as unknown as Json,
  }));
  return { access, apps, appsRuntime: apps, resolveAppToolRisk: apps.agentToolRisk };
};
