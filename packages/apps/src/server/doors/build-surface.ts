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
  isVendoError,
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
  componentSources,
  type AppDocument,
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
import { checkComponentScreen, reviewComponentScreenInput } from "../checking/component-screen.js";
import { screenCatalog } from "../checking/screen-typings.js";
import { queryEvidence } from "../checking/evidence.js";
import { createAppFloor, floorChecks } from "../checking/floor.js";
import { createCheckingLayer, judgmentRules } from "../checking/layer.js";
import { reviewerCheck } from "../checking/reviewer.js";
import { generationDependencies, resolveProvider } from "../runtime/generation-context.js";
import { createProgressiveQueryResolver } from "../persistence/open.js";
import type { EngineOps } from "../persistence/engine.js";
import { APPS_COLLECTION, appRecordInput, documentFromRecord, withoutSession } from "../persistence/persistence.js";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";
import type { AppsRuntime, CreateServerWork } from "../runtime/types.js";

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
}): Tree => ({
  // The format tag FIRST, so a caller that has only a tree's two structural
  // members — the component screen's flattened paint (`ComponentPaintResult`) is
  // exactly that — gets the version the channel gates on, while anything carrying
  // its own tag (a legacy island payload's included) keeps it.
  formatVersion: VENDO_TREE_FORMAT,
  ...structuredClone(source.tree),
  ...(source.components === undefined ? {} : { components: structuredClone(source.components) }),
  ...(source.componentTools === undefined ? {} : { componentTools: structuredClone(source.componentTools) }),
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
 * The ask, through the ONE engine: assembly first, and a build only if assembly
 * asks for one by name.
 *
 * `input.why` is the §4.5 hand-off — `vendo_make` already ran the assembler and
 * it escalated, so re-routing here would run a second full agent over an answer
 * this door already has. Every OTHER caller (the HTTP route, a seed script, a
 * host calling `apps.create` directly) starts where `vendo_make` starts, because
 * the seam routes, not the caller.
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
): Promise<{ kind: "assembled"; document: AppDocument } | { kind: "escalate"; why: string }> => {
  const { config, engine, appId, createStartedAt, watchdog, failBuild } = bound;
  if (config.screen === undefined) {
    return failBuild(NO_ASSEMBLER, false, [NO_ASSEMBLER], "not-implemented");
  }
  let routed: Awaited<ReturnType<ScreenAssembler["assemble"]>>;
  /** The row is the check that "assembled" is true rather than merely intended:
   *  `authored` upserts it iff the seam really compiled and painted the document,
   *  so a save nobody can render leaves no row. Read inside the catch's reach,
   *  because `engine.get` says an ABSENT row with `null` — a throw is the store
   *  failing to answer, which says nothing at all about the screen. */
  let stored: Awaited<ReturnType<EngineOps["get"]>> = null;
  try {
    routed = await config.screen.assemble({
      appId,
      request: input.prompt,
      ...(input.onView === undefined ? {} : { onView: (part) => input.onView?.(part) }),
    }, ctx);
    if (routed.kind === "assembled") stored = await engine.get(APPS_COLLECTION, appId);
  } catch (error) {
    const { reason, retryable } = buildFailureReason(error);
    const detail = isVendoError(error) && Array.isArray(error.detail)
      ? error.detail.filter((item): item is string => typeof item === "string")
      : [];
    return failBuild(
      reason,
      retryable,
      detail.length > 0 ? detail : [safeErrorMessage(error)],
      isVendoError(error) ? error.code : "validation",
    );
  }
  if (routed.kind === "assembled") {
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
  // `escalate` — the assembler asking for the builder by name. Its one-line
  // `why` is all it hands over; the person's own ask is the brief.
  return { kind: "escalate", why: routed.why };
};

/**
 * The streamed view parts are last-write-wins, so the built app settles the
 * stream. On a resolver failure emit nothing rather than a data-less tree that
 * would blank the screen.
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

    // The front door has already routed this ask through the screen agent when
    // it hands over a `why` (`vendo_make`), so re-routing would spend a second
    // full agent run on an answer it already has.
    let why = input.why;
    if (why === undefined) {
      const routed = await routeThroughAssembler(
        { config, engine, appId, createStartedAt, watchdog, failBuild }, input, ctx);
      if (routed.kind === "assembled") return routed.document;
      why = routed.why;
    }
    // ── The ask is the brief ────────────────────────────────────────────────
    // Nothing re-plans it and nothing outlines it: the escalation is the claim
    // that assembly cannot serve this ask, and the box is the only lane that can
    // find out what can. The person's own words travel to it verbatim, with the
    // escalation's one-line `why` beside them.
    //
    // Sandbox-gated up front rather than after the build spends its latency to
    // arrive at nothing.
    if (!lifecycle.available()) {
      return failBuild(NO_MACHINE, false, [NO_MACHINE], "not-implemented");
    }
    // No screen yet: the box has not written anything for one to show. The row
    // is what makes this a real app — it lists, opens and takes an edit — and
    // the paint below stays silent until there is something to paint.
    let app: AppDocument = {
      format: "vendo/app@1",
      id: appId,
      name: fallbackAppName(input.prompt),
      ui: "tree",
    };

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
        document: app,
        request: input.prompt,
        why,
      }, ctx, generationDeps);
      app = served.document;
      if (served.failed !== undefined) serverWorkFailed = served.failed;
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
        // Failure sentences — `served.failed`, collected into serverWorkFailed
        // above — are the outside failure report's to carry, exactly once. The envelope
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

    if (input.appId === undefined) {
      throw new VendoError("validation", "validate needs an appId");
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
        ...(deps.routes === undefined ? {} : { routes: deps.routes }),
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
      // A product with tools but no READ tool has no data a screen can show,
      // and nothing else in the prompt says so. That silence is where a model
      // invents a tool name instead of admitting there is none for the ask.
      if (!tools.some(({ risk }) => risk !== "write" && risk !== "destructive")) {
        cards.push("- Nothing on this list can be READ, so a screen has no data to show from this product."
          + " If the person asks for data, use <Disclaimer> to say no tool provides it."
          + " Never name a tool that is not on this list, and never claim the data is empty or missing, which you cannot know.");
      }
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
        // Exactly the fields the floor reads, built directly rather than
        // through `generationDependencies`: none of the pipeline's other knobs
        // (theme, design rules, fill tiers, the partial-tree seam) is a fact about
        // an app, so none of them belongs in a check's inputs. The host's routes
        // ARE one — which pages exist is as much a fact as which tools do, and it
        // is what `routes-exist` measures a `<Link to>` against. `model` rides
        // along when the deployment has one and is absent when it does not — the
        // seam never spends it either way, and the AI reviewer is `validate`'s.
        deps: async () => ({
          catalog: config.catalog,
          ...(config.routes === undefined ? {} : { routes: config.routes }),
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
