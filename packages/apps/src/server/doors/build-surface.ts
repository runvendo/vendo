/**
 * The doors that BUILD an app, and the checks they can be asked to run on their
 * own: `create`, `validate`, `floor`, and `toolShapeBrief`.
 *
 * Lifted out of `createApps` unchanged.
 */
import {
  UNKNOWN_OUTPUT_SHAPE_NOTE,
  VENDO_APP_BUILD_FAILED_PREFIX,
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  VendoError,
  describeShapeWithSemantics,
  log,
  safeErrorMessage,
  type AppId,
  type Json,
  type RunContext,
  type UIPayload,
  vendoViewPart,
} from "@vendoai/core";
import {
  compilePlan,
  compileWire,
  componentSources,
  type AppDocument,
  type AppPlan,
  type PlanDisplay,
  type ScreenAssembler,
  type Tree,
  stripServerAuthoritativeFields,
} from "../../contract/index.js";
import {
  BUILD_WATCHDOG_REASON,
  NO_ASSEMBLER,
  NO_MACHINE,
  NOTHING_RENDERABLE,
  buildFailureReason,
  buildWatchdogMs,
  fallbackAppName,
  findingLine,
} from "./build-messages.js";
// The screen engine, by its own path: the contract door does not carry it yet.
import { SCREEN_FILE } from "../../contract/genui/component/index.js";
import {
  checkComponentScreen,
  reviewComponentScreenInput,
  screenCatalog,
} from "../checking/component-screen.js";
import { queryEvidence } from "../checking/evidence.js";
import { createAppFloor, floorChecks } from "../checking/floor.js";
import { createCheckingLayer, judgmentRules } from "../checking/layer.js";
import { reviewerCheck } from "../checking/reviewer.js";
import { asPayload } from "../generation/engine.js";
import { escalatedServer, escalationNeedsMachine } from "../generation/lanes.js";
import { skeletonFromPlan } from "../generation/skeleton.js";
import { UNSTORED_APP_ID, validateCompiledCreate } from "../generation/validation/validate.js";
import { generationDependencies, resolveProvider } from "../runtime/generation-context.js";
import { createProgressiveQueryResolver } from "../persistence/open.js";
import type { EngineOps } from "../persistence/engine.js";
import { APPS_COLLECTION, appRecordInput, documentFromRecord, withoutSession } from "../persistence/persistence.js";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";
import type { AppsRuntime, CreateServerWork } from "../runtime/types.js";
import { wireCompileOptionsFor } from "../runtime/wire-options.js";

/** What `create` is handed, named once so the helpers below can take it. */
type CreateInput = Parameters<AppsRuntime["create"]>[0];

/** v2 spec §1 — assemble the emitted payload: the tree plus document islands
 *  at payload level (the renderer lifts them into the shared walk). Exported for
 *  the harness runtime's hot-path render seam, which must produce the IDENTICAL
 *  payload shape this emitter does. */
export const assembleTree = (source: {
  tree: UIPayload | Tree | Pick<Tree, "root" | "nodes">;
  components?: Record<string, string>;
  /** W4b — the stamped per-island tool manifests ride beside the sources. */
  componentTools?: Record<string, string[]>;
  /** The plan's arrival posture (redesign spec §5): inline card or opened stage.
   *  It is assembled HERE rather than at either emitter so the in-process
   *  generation and the harness render seam cannot disagree about the field.
   *  Absent stays absent — the client reads that as inline. */
  display?: PlanDisplay;
}): Tree => ({
  // The format tag FIRST, so a caller that has only a tree's two structural
  // members — the component screen's flattened paint (`ComponentPaintResult`) is
  // exactly that — gets the version the channel gates on, while anything carrying
  // its own tag (a legacy island payload's included) keeps it.
  formatVersion: VENDO_TREE_FORMAT,
  ...structuredClone(source.tree),
  ...(source.components === undefined ? {} : { components: structuredClone(source.components) }),
  ...(source.componentTools === undefined ? {} : { componentTools: structuredClone(source.componentTools) }),
  ...(source.display === undefined ? {} : { display: source.display }),
} as Tree);

/**
 * 0.4.5 E2E cert (defect D) — the build's dead-man switch. The `failBuild` catch
 * persists a terminal failure when the build turn THROWS, but a build task that
 * hangs (a provider stream that never settles) or dies with its promise chain
 * severed settles nothing: the embed polls {kind:"pending"} forever. A timer is
 * independent of the promise chain, so it fires either way; if by then NOTHING
 * was persisted for this id, it writes the terminal failed record itself so
 * open() resolves the embed with a reason. Any persist clears it; a late success
 * after a fired watchdog overwrites the failed record — self-healing, never the
 * reverse.
 */
const startBuildWatchdog = (
  engine: EngineOps,
  appId: AppId,
  prompt: string,
  subject: string,
): ReturnType<typeof setTimeout> => {
  const watchdog = setTimeout(() => {
    void (async () => {
      if (await engine.get(APPS_COLLECTION, appId) !== null) return;
      await engine.put(APPS_COLLECTION, appRecordInput({
        format: "vendo/app@1",
        id: appId,
        name: fallbackAppName(prompt),
        buildFailed: { reason: BUILD_WATCHDOG_REASON, retryable: true, at: new Date().toISOString(), prompt },
      }, subject, false, "screen-agent"));
      log({
        code: "apps.build-watchdog-fired",
        level: "error",
        message: `[vendo] app build watchdog (${appId}): no app record and no failure landed within ${buildWatchdogMs()}ms — persisted a terminal failed record so the embed resolves instead of polling forever.`,
      });
    })().catch(() => undefined);
  }, buildWatchdogMs());
  (watchdog as { unref?: () => void }).unref?.();
  return watchdog;
};

/** The terminal failed record + the classified throw, shared by a thrown
 *  build turn and an honest refusal. */
const createBuildFailer = (bound: {
  engine: EngineOps;
  appId: AppId;
  prompt: string;
  subject: string;
  watchdog: ReturnType<typeof setTimeout>;
}) => {
  const { engine, appId, prompt, subject, watchdog } = bound;
  return async (
    reason: string,
    retryable: boolean,
    detail: readonly string[],
    code: VendoError["code"] = "validation",
  ): Promise<never> => {
    await engine.put(APPS_COLLECTION, appRecordInput({
      format: "vendo/app@1",
      id: appId,
      name: fallbackAppName(prompt),
      buildFailed: { reason, retryable, at: new Date().toISOString(), prompt },
    }, subject, false, "screen-agent")).catch(() => undefined);
    clearTimeout(watchdog);
    log({
      code: "apps.build-failed",
      level: "error",
      message: `[vendo] app build failed (${appId}): ${reason}${detail.map((line) => `\n  - ${line}`).join("")}`,
    });
    throw new VendoError(
      code,
      `${VENDO_APP_BUILD_FAILED_PREFIX}: ${reason}`,
      { appId, reason, retryable, issues: [...detail] },
    );
  };
};

/**
 * The BRIEF this build runs on: the escalated plan, or the assembler's answer to
 * the ask.
 *
 * `input.plan` is the §4.5 hand-off — `vendo_make` already ran the assembler, it
 * escalated, and the plan it wrote is the brief. Every OTHER caller of this door
 * (the HTTP route, a seed script, a host calling `apps.create` directly) starts
 * where `vendo_make` starts, because there is one engine and the seam routes,
 * not the caller: assembly first, and a build only if assembly asks for one by
 * name.
 */
const routeThroughAssembler = async (
  bound: Pick<AppsRuntimeContext, "config" | "engine"> & {
    appId: AppId;
    createStartedAt: number;
    watchdog: ReturnType<typeof setTimeout>;
    failBuild: ReturnType<typeof createBuildFailer>;
  },
  input: CreateInput,
  ctx: RunContext,
): Promise<{ kind: "assembled"; document: AppDocument } | { kind: "plan"; planText: string | undefined }> => {
  const { config, engine, appId, createStartedAt, watchdog, failBuild } = bound;
  if (config.screen === undefined) {
    return failBuild(NO_ASSEMBLER, false, [NO_ASSEMBLER], "not-implemented");
  }
  let routed: Awaited<ReturnType<ScreenAssembler["assemble"]>>;
  try {
    routed = await config.screen.assemble({
      appId,
      request: input.prompt,
      ...(input.onView === undefined ? {} : { onView: (part) => input.onView?.(part) }),
    }, ctx);
  } catch (error) {
    const { reason, retryable } = buildFailureReason(error);
    const detail = error instanceof VendoError && Array.isArray(error.detail)
      ? error.detail.filter((item): item is string => typeof item === "string")
      : [];
    return failBuild(
      reason,
      retryable,
      detail.length > 0 ? detail : [safeErrorMessage(error)],
      error instanceof VendoError ? error.code : "validation",
    );
  }
  if (routed.kind === "assembled") {
    // The row is the check that "assembled" is true rather than merely
    // intended: `authored` upserts it iff the seam really compiled and
    // painted the document, so a save nobody can render leaves no row.
    const stored = await engine.get(APPS_COLLECTION, appId).catch(() => null);
    if (stored === null) return failBuild(NOTHING_RENDERABLE, true, [NOTHING_RENDERABLE]);
    clearTimeout(watchdog);
    log({
      code: "apps.assembled",
      level: "info",
      message: `[vendo] assembled app=${appId} total=${((Date.now() - createStartedAt) / 1000).toFixed(1)}s`,
    });
    return { kind: "assembled", document: withoutSession(documentFromRecord(stored)) };
  }
  if (routed.kind === "unavailable") {
    return failBuild(routed.why, true, [routed.why]);
  }
  // `escalate` — the assembler asking for the builder by name. The plan it
  // wrote is read back through the same slot `vendo_make` reads it with.
  return { kind: "plan", planText: await config.escalatedPlan?.(appId, ctx).catch(() => undefined) };
};

/**
 * The streamed view parts are last-write-wins and the plan's own skeleton is
 * still the last thing painted, so the built app settles the stream. On a
 * resolver failure emit nothing rather than a data-less tree that would blank
 * the screen.
 */
const paintSettledTree = async (
  caller: AppsRuntimeContext["caller"],
  app: AppDocument,
  ctx: RunContext,
  onView: CreateInput["onView"],
  appId: AppId,
): Promise<void> => {
  if (onView === undefined || app.tree?.formatVersion !== VENDO_TREE_FORMAT) return;
  const tree = assembleTree({
    tree: app.tree,
    components: componentSources(app.components),
    componentTools: app.componentTools,
  });
  stripServerAuthoritativeFields(tree);
  const resolver = createProgressiveQueryResolver(caller, app, ctx);
  resolver.update(tree);
  tree.data = await resolver.complete().catch(() => tree.data ?? {});
  emitView(onView, appId, tree);
};

/** 06-apps §§8–9 — the venue verdict and drift report are server-authoritative
 *  and a model-written tree must never smuggle either into the live stream: a
 *  freshly generated app has no approval and no drifted pins by definition.
 *
 *  Built through `vendoViewPart`, the ONE producer of a view part, so this door
 *  and the render seam cannot emit two different shapes. */
const emitView = (onView: CreateInput["onView"], appId: AppId, payload: Tree): void => {
  stripServerAuthoritativeFields(payload);
  const view = vendoViewPart({ appId, payload: payload as unknown as UIPayload });
  if (view !== undefined) onView?.(view.part);
};

const createCreateDoor = (
  deps: Pick<AppsRuntimeContext,
    "config" | "engine" | "caller" | "lifecycle" | "claimSlot" | "generationToolContext"
    | "reportLifecycle" | "runServerWork">,
): AppsRuntime["create"] => {
  const { config, engine, caller, lifecycle, claimSlot, generationToolContext } = deps;
  const { reportLifecycle, runServerWork } = deps;
  return async (input, ctx) => {
    if (config.model === undefined) {
      throw new VendoError("not-implemented", "generation requires a model");
    }
    // Mint before generation so every partial already carries its permanent id
    // — unless the front door already did, in which case an escalated plan's
    // skeleton and this build's paints share one stream.
    const appId = input.appId ?? `app_${globalThis.crypto.randomUUID()}`;
    const createStartedAt = Date.now();
    // B1, for a caller that minted its id HERE. The front door claims before
    // it routes (it minted earlier), so it passes no slot down.
    if (input.slot !== undefined) await claimSlot(appId, input.slot, ctx);
    const watchdog = startBuildWatchdog(engine, appId, input.prompt, ctx.principal.subject);
    const generationDeps = generationDependencies(config, config.model, await generationToolContext(ctx));

    const failBuild = createBuildFailer({ engine, appId, prompt: input.prompt, subject: ctx.principal.subject, watchdog });

    let planText = input.plan;
    if (planText === undefined) {
      const routed = await routeThroughAssembler(
        { config, engine, appId, createStartedAt, watchdog, failBuild }, input, ctx);
      if (routed.kind === "assembled") return routed.document;
      planText = routed.planText;
    }
    // ── The plan is the brief ───────────────────────────────────────────────
    // No brain re-plans it: `<Server kind>` is the escalating agent's own
    // declaration (see `escalatedServer`), the skeleton is the outline already
    // on the person's screen, and the plan text travels to the box verbatim.
    const compiled = planText === undefined ? undefined : compilePlan(planText, {
      tools: (generationDeps.tools ?? []).map(({ name }) => name),
      components: config.catalog.map(({ name }) => name),
    });
    // No plan file, or one the compiler could not read: the ask is the whole
    // brief and the box is the lane, which is exactly what an escalation with
    // no `<Server>` gets. Never a lost build.
    const plan: AppPlan = compiled?.plan
      ?? { name: fallbackAppName(input.prompt), groups: [], queries: [], cannot: [] };
    const planned = { ...plan, server: escalatedServer(plan, input.prompt) };
    // Sandbox-gated, exactly where §4.5 put the gate — and gated on the ONE
    // expression `edit` reads (`escalationNeedsMachine`), which is the whole
    // fix: this used to refuse EVERY escalation on a host with no sandbox,
    // while edit refused only a box, so an automation you could ask for by
    // editing an app you could not ask for by making one. A build that IS the
    // box still says so up front rather than spending its latency to arrive at
    // nothing; the plan compile above costs no model call.
    if (escalationNeedsMachine(planned.server) && !lifecycle.available()) {
      return failBuild(NO_MACHINE, false, [NO_MACHINE], "not-implemented");
    }
    const skeleton = skeletonFromPlan(planned);
    let app: AppDocument = {
      format: "vendo/app@1",
      id: appId,
      name: planned.name,
      ui: "tree",
      tree: asPayload(skeleton.tree),
    };
    if (app.tree !== undefined) stripServerAuthoritativeFields(app.tree);

    // The outline reaches the screen as the app's own first paint. It is
    // already there as the plan's skeleton — this is the same tree on the same
    // stream, which is what makes the outline BECOME the app rather than being
    // replaced by a second card.
    let unsavedReason: string | undefined;
    try {
      await engine.put(APPS_COLLECTION, appRecordInput(app, ctx.principal.subject, false, "screen-agent"));
    } catch (error) {
      // A persist failure degrades the app to view-only — it renders, it just
      // is not in the user's list and cannot be reopened. Far better than
      // discarding a working view, but never silent.
      unsavedReason = safeErrorMessage(error);
      log({
        code: "apps.create-not-saved",
        level: "error",
        message: `[vendo] app not saved (${appId}): the view rendered but the store rejected it — ${unsavedReason}`,
      });
    }
    clearTimeout(watchdog);
    if (unsavedReason !== undefined) {
      // The server lane writes through the same store the persist just failed
      // on, and it assumes a stored app — so an unsaved create ends here.
      input.onUnsaved?.(unsavedReason);
      return structuredClone(app);
    }
    await reportLifecycle("create", app.id, ctx);
    // A create used to swallow this whole lane: `edit` read `served.failed` and
    // refused, `create` read nothing at all and the catch below only warned, so
    // an app whose server side never got built painted its skeleton and reported
    // itself complete — a live empty app declared successful (2026-08-11). The
    // app still RESOLVES, because it is real and on screen; what it no longer
    // does is claim the server work landed.
    let serverWorkFailed: string[] | undefined;
    try {
      const served = await runServerWork({
        plan: planned,
        ...(planText === undefined ? {} : { planText }),
        document: app,
        request: input.prompt,
      }, ctx, generationDeps);
      app = served.document;
      if (served.failed !== undefined) serverWorkFailed = served.failed;
      // A plan that asked to be SERVED and did not get its surface is the same
      // half-built app: the box ran, but the flip was refused (`issues`), so the
      // person is looking at a skeleton with nothing behind it. `edit` hands
      // these back to its caller as `issues`; a create returns a document, so
      // this callback is its only channel for them. `served` is compiler-gated
      // to kind="box" (plan/compile.ts), so no automation issue arrives here.
      else if (planned.server?.served === true && served.issues !== undefined) {
        serverWorkFailed = served.issues;
      }
      for (const finding of served.findings) {
        console.info(findingLine(finding));
      }
      // #881 — hand the lane's outcome to the caller, exactly as EditResult
      // carries it for an edit: the automation envelope raises the thread
      // card, and failure sentences reach the person instead of dying in
      // this log.
      const work: CreateServerWork = {
        ...(served.automation === undefined ? {} : { automation: served.automation }),
        ...(served.graduated === undefined ? {} : { graduated: served.graduated }),
        // Failure sentences — `served.failed`, and the issues a plan-required
        // serve escalated (both collected into serverWorkFailed above) — are
        // the outside failure report's to carry, exactly once. The envelope
        // carries what the SUCCESS half produced: the automation that raises
        // the thread card, and non-escalated caveat issues.
        ...((served.issues ?? []).length === 0 || serverWorkFailed === served.issues ? {} : { issues: served.issues }),
      };
      // `graduated` alone is not a callback-worthy event — a box succeeding is
      // the normal case, and a clean build stays SILENT (the failure-only
      // contract this door shipped with). The envelope fires when it carries
      // an automation or caveat issues; graduated rides along.
      if (work.automation !== undefined || work.issues !== undefined) {
        input.onServerWork?.(work);
      }
    } catch (error) {
      serverWorkFailed = [safeErrorMessage(error)];
    }
    // Reported OUTSIDE the try on purpose: reporting from inside it let a
    // throwing consumer re-enter this very catch as a second "server work
    // failed", call the callback twice, and take `paintSettledTree` with it.
    // The failure rides the same CreateServerWork envelope the success path
    // publishes (#881) — `failed` is its failure half.
    if (serverWorkFailed !== undefined) {
      input.onServerWork?.({ failed: serverWorkFailed });
      log({
        code: "apps.server-work-failed",
        level: "error",
        message: `[vendo] server work failed for ${appId} (the screen stands, its server side does not): ${serverWorkFailed.join("; ")}`,
      });
    }
    await paintSettledTree(caller, app, ctx, input.onView, appId);
    log({
      code: "apps.gen-create-complete",
      level: "info",
      message: `[vendo] gen create complete${serverWorkFailed === undefined ? "" : " (server work failed)"} app=${appId} total=${((Date.now() - createStartedAt) / 1000).toFixed(1)}s`,
    });
    return structuredClone(app);
  };
};

/**
 * A component screen's queries, run for real — what makes stage 4 of the gauntlet
 * (`checkComponentScreen`) the same call the finished screen makes.
 *
 * Through the SAME guard-bound caller `open()` and `authored` resolve a tree's
 * queries with: one guard decision per query, this person's authority, the app
 * venue. The document handed over is the app's IDENTITY and nothing more, which is
 * all `callQuery` reads off it (persistence/call.ts) — the gauntlet runs before
 * there is a row to read a real one from, and inventing the rest of a document here
 * would be inventing facts about an app.
 *
 * A refusal THROWS, because that is the shape the gauntlet reports it in: it turns
 * the message into a `run` issue naming the query, which is the sentence the screen's
 * author has to act on.
 */
const screenQueryRunner = (
  caller: AppsRuntimeContext["caller"],
  ctx: RunContext,
) => async (appId: AppId, tool: string, input?: unknown): Promise<unknown> => {
  const outcome = await caller.callQuery(
    { format: VENDO_APP_FORMAT, id: appId, name: "", ui: "tree" },
    tool,
    (input ?? {}) as Json,
    ctx,
  );
  if (outcome.status === "ok") return outcome.output;
  if (outcome.status === "error") throw new Error(outcome.error.message);
  if (outcome.status === "blocked") throw new Error(outcome.reason);
  if (outcome.status === "connect-required") {
    throw new Error(`${outcome.connect.toolkit} is not connected, so this cannot be read`);
  }
  throw new Error("this read needs the person's approval, which a check cannot ask for");
};

/** The screen a stored app IS, when it is a component screen — its `app.tsx`, as
 *  `commitSource` landed it. A spilled screen (past the inline cap) is not one of
 *  these: the text is the whole artifact, and a blob fetch inside a check would be
 *  a second way to read an app. */
const componentScreenOf = (document: AppDocument): string | undefined => {
  const text = document.source?.[SCREEN_FILE]?.text;
  return typeof text === "string" && text.trim() !== "" ? text : undefined;
};

const createValidateDoor = (
  deps: Pick<AppsRuntimeContext, "config" | "caller" | "requireOwned" | "generationToolContext">,
): AppsRuntime["validate"] => {
  const { config, caller, requireOwned, generationToolContext } = deps;
  return async (input, ctx) => {
    if (config.model === undefined) {
      // The floor's fact checks read the generation dependencies, which are
      // built around a model. Nothing to hide behind: say so.
      throw new VendoError("not-implemented", "validate requires a model");
    }
    // The reviewer's seat rides along on the floor's deps: this door is the one
    // place the reviewer runs (below), so it is the one place the seat has to
    // arrive. Unset, everything here is what it was.
    const generated = generationDependencies(config, config.model, await generationToolContext(ctx));
    const deps = config.reviewModel === undefined
      ? generated
      : { ...generated, reviewModel: config.reviewModel };

    if (typeof input.document === "string") {
      // Wire text, not a stored app: compile it in the PRODUCTION dialect (the
      // one every other compile of model wire uses — a compile that lacked
      // these options once failed every app built on inline tool references),
      // then run the shipped create validation. Its issues are already the
      // sentences a model can act on.
      const compiled = compileWire(
        input.document,
        wireCompileOptionsFor(deps),
      );
      const { document, issues } = await validateCompiledCreate(compiled, deps);
      if (document === undefined) {
        // Wire that did not compile, or islands that did not pass admission:
        // the screen text the floor would read does not exist yet, so those
        // sentences are the whole answer.
        return { ok: false, findings: issues.map((message) => ({ severity: "block" as const, message })) };
      }
      // …and then the SAME floor every other door runs, on the document the
      // wire assembled to.
      const findings = await createCheckingLayer({ deps, checks: floorChecks(deps) })
        .run({ document: { ...document, id: UNSTORED_APP_ID } as AppDocument, request: "" });
      return { ok: !findings.some(({ severity }) => severity === "block"), findings };
    }

    if (input.appId === undefined) {
      throw new VendoError("validation", "validate needs an appId or a document to check");
    }
    // Editor-scoped, like edit itself: checking the shape of an app you may
    // change is part of changing it, and a mere viewer is masked as ever.
    const document = await requireOwned(input.appId, ctx);
    // The SAME floor create and edit run — the seven fact checks, the host's and
    // every plugged check, AND the AI reviewer. The reviewer was the
    // piece this door was missing: without it `validate` could not see invented
    // data, dishonest tool use, dead controls or dropped work, and could not
    // apply a single one of the host's own judgment RULES, which are not code and
    // which the reviewer is the only thing that can read. The skill teaches
    // "validate after every edit — faster and surer than re-reading your own
    // work", so half a checker answering "ok" was the worst lie available here.
    //
    // Composed through the same `checkingFor` every other author uses, including
    // deriving the rubric with the same function the layer exposes it with, so the
    // rubric the reviewer reads and `layer.rubric` cannot diverge. Fail-open is
    // unchanged: silence, a refusal and a failed request all mean no findings.
    //
    // `samples` are the app's OWN queries, run (`queryEvidence`). This door used
    // to pass none, on the reasoning that a verb call has run no queries — true,
    // and it left the reviewer judging markup with nothing behind it, which is
    // half its rubric switched off. A double-counted headline ($11,216 shown,
    // ~$6,276 true, demo-bank 2026-08-06) is invisible in the markup and obvious
    // beside the rows.
    //
    // `request` is empty because a verb call carries no user text — the checks
    // that read it treat that as "no carve-out", which is the conservative
    // direction.
    const plugged = config.checks ?? [];
    // A COMPONENT screen has no wire markup to print and no tree to fact-check: the
    // app IS its `app.tsx`, so the gauntlet is its mechanical half and the reviewer
    // reads the file itself. Both run over the STORED screen, which is the whole
    // point of the row-scoped door — it judges what the person is about to keep.
    const screen = componentScreenOf(document);
    if (screen !== undefined) {
      const runQuery = screenQueryRunner(caller, ctx);
      const checked = await checkComponentScreen({
        source: screen,
        hostTools: deps.tools ?? [],
        catalog: screenCatalog(deps.catalog),
        runQuery: (tool, queryInput) => runQuery(document.id, tool, queryInput),
        // The same slot the floor honors: `validate` runs the identical gauntlet,
        // so it must run it on the identical toolchain.
        ...(config.toolchain === undefined ? {} : { toolchain: config.toolchain }),
      });
      if (!checked.ok) {
        // The gauntlet's own repair instructions, verbatim and with no locus: each
        // one already names the screen's line and what to write instead.
        return { ok: false, findings: checked.issues.map(({ message }) => ({ severity: "block" as const, message })) };
      }
      // …and then the ONE judging call, on the same rubric every other author's
      // screen faces, reading the TSX and the rows its queries really returned
      // rather than printed wire (`reviewComponentScreenInput`).
      const judged = await createCheckingLayer({
        deps,
        checks: [
          // No `samples`: the screen's rendering already carries what its queries
          // returned, under the same truncation the wire reviewer uses.
          reviewerCheck(
            deps,
            undefined,
            judgmentRules(plugged),
            reviewComponentScreenInput({ source: screen, queryResults: checked.queries ?? {} }),
          ),
          ...plugged,
        ],
      }).run({ document, request: "" });
      return { ok: !judged.some(({ severity }) => severity === "block"), findings: judged };
    }
    const samples = await queryEvidence(document, config.tools, ctx);
    const findings = await createCheckingLayer({
      deps,
      // The thorough door: the shared floor AND the reviewer. Off the
      // scripted-create hot path, so the tsc pass is affordable here (§7.1).
      checks: [...floorChecks(deps), reviewerCheck(deps, samples, judgmentRules(plugged)), ...plugged],
    }).run({ document, request: "" });
    return { ok: !findings.some(({ severity }) => severity === "block"), findings };
  };
};

/** The build slice of `AppsRuntime`. */
export const createBuildSurface = (
  deps: Pick<AppsRuntimeContext,
    "config" | "engine" | "caller" | "lifecycle" | "claimSlot" | "generationToolContext"
    | "reportLifecycle" | "runServerWork" | "requireOwned" | "runtime">,
): Pick<AppsRuntime, "create" | "toolShapeBrief" | "floor" | "agentToolRisk" | "validate"> => {
  const { config, generationToolContext } = deps;
  return {
    create: createCreateDoor(deps),
    validate: createValidateDoor(deps),

    async toolShapeBrief(ctx) {
      // Re-resolved on every call, which is the whole contract: the provider form
      // of `semantics` re-merges the local `tools.json` with the cloud-owned
      // overrides, and memoizing it would lock a host's annotations for the
      // lifetime of the process.
      const semantics = resolveProvider(config.semantics) ?? {};
      const { tools, toolShapes } = await generationToolContext(ctx);
      const header = "TOOL RESPONSE SHAPES (what each tool really returns, with this host's own field semantics)."
        + " Bind only to fields these name, and read the annotations: :money.cents is integer CENTS,"
        + " :money.dollars whole dollars, :date.iso and :date.epoch machine dates, :enum(a|b) a closed"
        + " vocabulary, :id an opaque host identifier, :percent.ratio 0..1.";
      if (tools === undefined || tools.length === 0) return `${header}\n- (this product exposes no tools)`;
      const cards = tools.map(({ name }) => {
        const shape = toolShapes?.[name];
        return shape === undefined
          ? `- ${name} — ${UNKNOWN_OUTPUT_SHAPE_NOTE}`
          : `- ${name} — shape: ${describeShapeWithSemantics(shape, semantics[name] ?? {})}`;
      });
      return `${header}\n${cards.join("\n")}`;
    },

    floor(ctx, options) {
      // The ROW HALF, off for a floor whose paint is a READ (`saves: false`).
      // Every other stage is identical, which is the whole point of one floor: a
      // reopened screen faces exactly the checks its save faced.
      const rowHalf = options?.saves === false ? {} : {
        delivered: (input: { appId: AppId; name: string }, source: string) =>
          deps.runtime().authoredScreen({ ...input, source }, ctx),
        refused: (input: { appId: AppId; blocking: readonly string[] }) =>
          deps.runtime().refusedScreen(input),
      };
      return createAppFloor({
        // Exactly the four fields the floor reads, built directly rather than
        // through `generationDependencies`: none of the pipeline's other knobs
        // (theme, design rules, fill tiers, the partial-tree seam) is a fact about
        // an app, so none of them belongs in a check's inputs. `model` rides along
        // when the deployment has one and is absent when it does not — the seam
        // never spends it either way, and the AI reviewer is `validate`'s.
        deps: async () => ({
          catalog: config.catalog,
          ...(config.model === undefined ? {} : { model: config.model }),
          ...await generationToolContext(ctx),
        }),
        ...(config.checks === undefined ? {} : { checks: config.checks }),
        ...(config.toolchain === undefined ? {} : { toolchain: config.toolchain }),
        // The component gauntlet's outside reaches, which a checking module cannot
        // hold itself: the screen's queries, the row-and-source a passing screen
        // earns, and the reason a refused one earned none. All three are this
        // runtime's own doors, bound to this caller's ctx.
        runQuery: screenQueryRunner(deps.caller, ctx),
        ...rowHalf,
      });
    },

    /**
     * No contextual projection for app self-mutation.
     *
     * Yousef's ruling (2026-07-28): an app edit does not need approval. Changing
     * your own view is not an act on the world — the static descriptors say
     * `read` for create and edit, and there is nothing per-call that should
     * raise them. What an app DOES still carries full ceremony: every host tool
     * an app calls goes through the guard on its own risk, an away run's first
     * ungranted mutating step parks the normal card, and egress needs the
     * owner's approval before a machine is provisioned.
     *
     * `undefined` means the static descriptor stands.
     */
    async agentToolRisk() {
      return undefined;
    },
  };
};
