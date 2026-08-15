/**
 * 06-apps — the app generation runtime, and every seam only a composition can
 * fill: the box's env and inference door, the multi-party Cloud gate, the
 * cross-subject promote door, the screen agent in front of the conductor, and
 * the arming seam onto the automations engine composed after it.
 */
import {
  buildEnv,
  createApps,
  createAppTokens,
  type AppsConfig,
} from "@vendoai/apps";
import { unattendedIrreversibilityCheck } from "@vendoai/automations";
import { screenAssembler } from "./screen-agent.js";
import {
  engineOverAdapter,
  joinUrl,
  VendoError,
  type AppDocument,
  type AppId,
  type Json,
  type RunContext,
  type WorkspaceFs,
} from "@vendoai/core";
import { appAccess } from "@vendoai/store";
import { askUserRegistry } from "./ask-user.js";
import { searchRuntimeCatalog } from "./catalog.js";
import { cloudApps } from "./cloud-apps.js";
import { cloudKeyOptions, positiveIntegerEnv } from "./compose-selection.js";
import type { VendoComposition } from "./compose-context.js";
import { vendoVerbsRegistry } from "./vendo-verbs.js";
import { BASE_PATH, environment } from "./wire/shared.js";

// The box env assembler the machine lifecycle calls at provision: rotate the
// app token, compose the callback doors from the operator-set public origin
// (the wire lives under it at BASE_PATH), and inject granted secrets — the
// apps runtime resolves the app's active grants and passes them here (Lane
// E), so only declared ∩ granted secret values enter the box. A BYO model
// key is just such a secret: declare it, grant it, and it rides the same
// injection path as any other key.
// execution-v2 Wave 3 — the box's inference door (the in-box coding agent's
// model). SELECTION LAW: the explicit VENDO_INFERENCE_URL+KEY pair wins;
// otherwise VENDO_API_KEY rides the console's Anthropic-compatible model gateway
// — the same key that provisions the Cloud machine funds its model (chat
// inference already does, via vendoModel's vendo-cloud rung; a machine without
// this rung fails every in-box task); otherwise the box gets no inference door
// and says so.
//
// There is deliberately no ANTHROPIC_API_KEY rung: a provider key in the
// deployment's environment used to point every box at api.anthropic.com and bill
// that account, chosen by nothing anyone wrote down. A host who wants their own
// endpoint names it — both halves of the pair, explicitly.
const boxInference = (): { url: string; key: string; model?: string } | undefined => {
  const url = environment("VENDO_INFERENCE_URL");
  const key = environment("VENDO_INFERENCE_KEY");
  const model = environment("VENDO_INFERENCE_MODEL");
  if (url !== undefined && key !== undefined) {
    return { url, key, ...(model === undefined ? {} : { model }) };
  }
  const cloud = cloudKeyOptions();
  if (cloud !== undefined) {
    // The gateway base mirrors vendoModel's vendo-cloud rung: `<console>/api/v1`.
    const base = (cloud.baseUrl ?? "https://console.vendo.run").replace(/\/+$/, "");
    // The gateway serves the vendo model family as literal ids (`vendo` is
    // the flagship); the box harness's own default is a raw claude-* id the
    // gateway would grace-remap, so pin the family name unless the operator
    // chose a model via VENDO_INFERENCE_MODEL.
    return {
      url: base.endsWith("/api/v1") ? base : `${base}/api/v1`,
      key: cloud.apiKey,
      model: model ?? "vendo",
    };
  }
  return undefined;
};

// Lane E — the implicit skin domains for the machine egress allowlist: the
// box must always reach its own boundary (store + host-callback surface on
// the deployment origin, and — Wave 3 — the inference endpoint host), never
// subject to declaration or approval. Assembled here because this file owns
// the same URLs it injects as VENDO_STORE_URL / VENDO_HOST_URL / inference.
const implicitMachineDomains = (configuredBaseUrl: string | undefined): string[] => {
  const domains = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value === undefined) return;
    try { domains.add(new URL(value).hostname); } catch { /* not a URL */ }
  };
  add(configuredBaseUrl);
  add(boxInference()?.url);
  return [...domains];
};

/** The seams composition assembles for the apps runtime, in the order the one
 *  function assembled them (the env knobs THROW on a typo, so they are read
 *  where they were read). */
interface AppsSeams {
  machineEnv: (
    app: AppDocument,
    grants?: { grantedSecrets: ReadonlySet<string> },
  ) => Promise<Record<string, string>>;
  boxTemplate: string | undefined;
  boxEditTimeoutMs: number | undefined;
  boxEditPollMs: number | undefined;
  appsCloud: ReturnType<typeof cloudKeyOptions>;
  screenWorkspace: (screenCtx: RunContext) => Promise<WorkspaceFs>;
  access: ReturnType<typeof appAccess>;
}

/** The box env assembler the machine lifecycle calls at provision. */
const machineEnvFor = (
  composition: VendoComposition,
  appTokens: ReturnType<typeof createAppTokens>,
): AppsSeams["machineEnv"] => {
  const { ops, urls, secrets } = composition;
  const machineEnv = async (
    app: AppDocument,
    grants?: { grantedSecrets: ReadonlySet<string> },
  ): Promise<Record<string, string>> => {
    if (ops === undefined) {
      throw new VendoError(
        "not-implemented",
        "Provisioning a machine app reads the app's owner out of Vendo's own drawer, so it needs "
        + "the store's named-operation surface: a SQL-backed store (`store: postgres(url)`, or the "
        + "local default) or a StoreOps-capable store (the Cloud hosted store). The configured "
        + "store is neither.",
      );
    }
    const record = await ops.engine.get("vendo_apps", app.id);
    const subject = record?.refs?.["subject"];
    if (typeof subject !== "string") {
      throw new VendoError("not-found", `app not found: ${app.id}`);
    }
    if (urls === undefined) {
      throw new VendoError(
        "validation",
        "machine provisioning requires VENDO_BASE_URL — the box's callback URLs must be this deployment's public origin",
      );
    }
    const boxBase = joinUrl(urls.publicUrl, `${BASE_PATH}/box`).href;
    const inferenceEndpoint = boxInference();
    const built = await buildEnv(app, {
      granted: grants?.grantedSecrets ?? new Set<string>(),
      secrets,
      storeUrl: boxBase,
      hostUrl: boxBase,
      appToken: await appTokens.mint(app.id, subject),
      // The in-box agent's model door (box-env sets VENDO_INFERENCE_URL/KEY).
      ...(inferenceEndpoint === undefined ? {} : { inference: async () => ({ url: inferenceEndpoint.url, key: inferenceEndpoint.key }) }),
    });
    // Pass the box's model choice through as a plain env var the harness reads.
    if (inferenceEndpoint?.model !== undefined) built.env["VENDO_INFERENCE_MODEL"] = inferenceEndpoint.model;
    return built.env;
  };
  return machineEnv;
};

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
    // The AI reviewer's own seat — the FAST pick. `fill` is the seat that
    // resolves through the family fast path (`resolveModels`: the paint model
    // when the default rode the ladder, else the default itself), so a
    // deployment with a fast model reviews on it and one without keeps
    // reviewing on the flagship. Judging a finished screen against its own
    // rows is a reading job; it was paying flagship rates for it.
    reviewModel: inference.seats.fill,
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

/** The seams that cross a block line — the automations sponsorship hooks and the
 *  served-app proxy. */
const appsHostSeams = (composition: VendoComposition): Partial<AppsConfig> => {
  const { urls } = composition;
  return {
    // Build contract §9.9 — sponsorship's two halves, composed HERE because
    // they cross the apps↔automations line and neither block may reach into
    // the other. Both ride the same late binding as `armAutomation` above
    // (automations is constructed after apps; every call happens later).
    //
    // The edit hook is what makes "anyone else editing invalidates the
    // sponsorship" true: the apps runtime knows who edited, the automations
    // engine knows who sponsors.
    //
    // Why these two seams NO-OP on an unset engine while `armAutomation` below
    // THROWS (F26 — deliberate, not an oversight): all three are unreachable
    // today, because nothing in this composition can skip constructing the
    // engine. If the invariant ever broke, the difference is what the caller
    // asked for. Arming is a request to CHANGE something; silently not arming an
    // automation the person just authored is the exact "quietly dropped work"
    // failure, so it refuses out loud. These two are enrichments of somebody
    // else's write and read: an app open and a landed edit must not fail because
    // the automations half is missing — there is simply no card and no
    // invalidation to report.
    onDocumentEdit: async (previous, next, editor) =>
      composition.automationsForArming?.onDocumentEdit(previous, next, editor),
    // Build contract §9.8 — where the authenticated served-app proxy lives. The
    // wire owns its base path, so it is filled here and nowhere else; the apps
    // block never invents a URL for a door it does not mount.
    //
    // ABSOLUTE, like the sandbox provider's URL this replaced: an MCP client (or
    // anything not already sitting on the host origin) cannot resolve a relative
    // path. So this seam is supplied ONLY when the deployment has named an origin
    // to build one from.
    //
    // Its ABSENCE is the answer, never a callback that exists and throws. The apps
    // block tests availability by presence (`config.servedProxyPath !== undefined`)
    // to shut the served lane, and a closure that always exists made that check a
    // lie: a machines+sandbox host with no VENDO_BASE_URL was offered the served
    // lane by the planner and only discovered the truth at serve time, after a box
    // was built and a surface flipped. Availability now means "can actually produce
    // a path", by construction.
    ...(urls === undefined ? {} : {
      servedProxyPath: (appId: AppId) =>
        joinUrl(urls.publicUrl, `${BASE_PATH}/apps/${encodeURIComponent(appId)}/serve/`).href,
    }),
  };
};

/** THE SEAM (blueprint §1 point 2) — the screen agent in front of the
 *  conductor, joined here because composition is what holds every half. */
const appsScreenSeam = (composition: VendoComposition, seams: AppsSeams): AppsConfig["screen"] => {
  const { inference, boundTools, briefing, catalog } = composition;
  const { screenWorkspace } = seams;
  return screenAssembler({
      // The SAME seats every other thinker runs on.
      models: inference.seats,
      // The SAME guard-bound registry. There is no second choke point.
      tools: boundTools,
      workspace: screenWorkspace,
      // Composition is what holds the catalog, so it is what answers whether
      // there is anything for `search_components` to find.
      hasComponents: catalog.length > 0,
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

/** The host's own knobs, the config-surface providers, and the machine lane. */
const appsTailSeams = (composition: VendoComposition, seams: AppsSeams): Partial<AppsConfig> => {
  const { config, automationsMounted, themeProvider, briefing, hostSemanticsProvider } = composition;
  const { secrets, sandbox } = composition;
  const { appsCloud, machineEnv, boxTemplate, boxEditTimeoutMs, boxEditPollMs } = seams;
  return {
    // Round-2 hardening — the host's reviewer assertion for the review-kind
    // remix lifecycle, threaded verbatim (see the CreateVendoConfig comment).
    ...(config.apps?.review === undefined ? {} : { review: config.apps.review }),
    // Wave 9 — a ladder-authored automation is armed through the automations
    // engine's own enable(), so the 07 §3 grant-capture flow runs at creation
    // and the missing standing-grant approvals surface on the edit result.
    armAutomation: async (appId, triggerId, armCtx) => {
      const automationsForArming = composition.automationsForArming;
      if (automationsForArming === undefined) {
        throw new VendoError("not-implemented", "the automations engine is not composed yet");
      }
      return automationsForArming.enable(appId, triggerId, armCtx);
    },
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
    // THE briefing pack, for the OTHER rung: the in-box builder reads it through
    // `box-lane.ts`, in the same bytes the screen agent above is handed.
    briefing,
    ...(appsCloud === undefined ? {} : { cloud: cloudApps(appsCloud) }),
    semantics: hostSemanticsProvider,
    secrets,
    // execution-v2 — the machine lifecycle's seams: the selected v2 adapter
    // (every provider speaks the canonical seam since the Wave 5 Cloud port)
    // and Lane C's env assembly. The box template (Node + the in-box agent
    // harness) is set by VENDO_BOX_TEMPLATE.
    machine: {
      ...(sandbox.adapter === undefined ? {} : { sandbox: sandbox.adapter }),
      buildEnv: machineEnv,
      implicitDomains: implicitMachineDomains(composition.configuredBaseUrl),
      ...(boxTemplate === undefined ? {} : { template: boxTemplate }),
      // The in-box agent edit is a minutes-long loop; operators tune its
      // long-poll budget when a base image or task needs longer than the
      // 8-minute default.
      ...(boxEditTimeoutMs === undefined ? {} : { boxEditTimeoutMs }),
      ...(boxEditPollMs === undefined ? {} : { boxEditPollMs }),
    },
  };
};

/** 06-apps §1 — the app runtime, and the three registries that join the ONE
 *  tool registry the moment it exists. */
export const composeApps = (composition: VendoComposition): Pick<VendoComposition,
  "appTokens" | "access" | "apps" | "appsRuntime" | "resolveAppToolRisk"> => {
  const { store, ops, actions, catalog, capability } = composition;
  // execution-v2 Lane C — the per-app box bearer store (hash rows are the
  // authority) shared by the machine-env assembler below (mint at provision)
  // and the wire's /box verification. The hash rows are one of Vendo's own
  // drawers, so they are reached by name through the engine family — the
  // deployment's own ops surface, or core's gate over a BYO adapter.
  const appTokens = createAppTokens(ops?.engine ?? engineOverAdapter(store));
  const machineEnv = machineEnvFor(composition, appTokens);
  const boxTemplate = environment("VENDO_BOX_TEMPLATE");
  const boxEditTimeoutMs = positiveIntegerEnv("VENDO_BOX_EDIT_TIMEOUT_MS");
  const boxEditPollMs = positiveIntegerEnv("VENDO_BOX_EDIT_POLL_MS");
  // ADAPTER RULE, share/publish seam: the apps block never reads the
  // environment — VENDO_API_KEY fills its CloudAppsClient slot HERE, at the
  // composition seam; unfilled, share/publish refuse with cloud-required.
  const appsCloud = cloudKeyOptions();
  // Wave 9 — `composition.automationsForArming` is the arming seam for
  // ladder-authored automations: filled with the automations engine composed
  // BELOW (arming only happens inside requests, which run after createVendo
  // returns, so the closure reference is safe — same pattern as the connections
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
    machineEnv,
    boxTemplate,
    boxEditTimeoutMs,
    boxEditPollMs,
    appsCloud,
    screenWorkspace,
    access,
  };
  const apps = createApps({
    ...appsStoreSeams(composition, seams),
    ...appsHostSeams(composition),
    screen: appsScreenSeam(composition, seams),
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
      input.appId === undefined ? {} : { appId: input.appId as AppId },
      ctx,
    ),
    searchComponents: async (query, limit) =>
      searchRuntimeCatalog(catalog, query, limit) as unknown as Json,
    schedule: async ({ appId, cron }, ctx) =>
      await apps.schedule(appId as AppId, cron, ctx) as unknown as Json,
  }));
  return { appTokens, access, apps, appsRuntime: apps, resolveAppToolRisk: apps.agentToolRisk };
};
