/**
 * 06-apps §8 — `AppsRuntime.pins`, the additive drift→rebase→fork surface.
 *
 * The ORCHESTRATION half of pins: `pins.ts` beside it stays the pure logic
 * (drift detection, baseline parsing, the pin schemas) and this module is the
 * part that reads and writes through the runtime's closure. Lifted out of
 * `createApps` unchanged — a rebase is a content change, so it is never invoked
 * automatically, and the fork gesture is deterministic (no model call).
 */
import {
  VENDO_TREE_FORMAT,
  VendoError,
  validateAppDocument,
  type AppDocument,
  type AppId,
  type RunContext,
} from "@vendoai/core";
import { applyPinFork } from "./generation/engine.js";
import { appRecordInput, rowFromRecord } from "./persistence.js";
import {
  hasDefaultExport,
  pinComponentName,
  pinForkSource,
  type PinBaseline,
} from "./pins.js";
import type { AppsRuntimeContext } from "./runtime-context.js";
import type {
  AppsRuntime,
  PinForkInput,
  PinForkResult,
  PinRebaseResult,
  VersionEntry,
} from "./types.js";

export type PinsSurfaceDeps = Pick<
  AppsRuntimeContext,
  | "config"
  | "apps"
  | "placementRows"
  | "history"
  | "requireOwned"
  | "persistEdit"
  | "failedEdit"
  | "assembleEdit"
  | "reportLifecycle"
  | "rungFor"
  | "runtime"
>;

/**
 * The empty-slot Remix gesture: mint the minimal base document the fork lands
 * in, so the fork itself is an ordinary recorded edit (rebase finds a full
 * trail).
 */
const mintForkBase = async (
  deps: Pick<PinsSurfaceDeps, "apps" | "placementRows" | "requireOwned" | "reportLifecycle">,
  baseline: PinBaseline,
  slot: string,
  ctx: RunContext,
  forkOnto: (base: AppDocument) => AppDocument,
): Promise<AppDocument> => {
  const minted: AppDocument = {
    format: "vendo/app@1",
    id: `app_${globalThis.crypto.randomUUID()}`,
    name: `${baseline.slot} remix`,
    ui: "tree",
    tree: {
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [{ id: "root", component: "Stack", source: "prewired" }],
    },
  };
  // Dry-run the fork BEFORE persisting the base, so a bad baseline
  // never strands an empty app.
  forkOnto(minted);
  await deps.apps.put(appRecordInput(minted, ctx.principal.subject));
  // The empty-slot gesture means "show the remix in THIS slot": the
  // placement is a ROW now (the pin on the document stays what it
  // always was — provenance, never location).
  await deps.placementRows.put(ctx.principal.subject, {
    slot,
    appId: minted.id,
    placedBy: ctx.principal.subject,
    placedAt: new Date().toISOString(),
  });
  await deps.reportLifecycle("create", minted.id, ctx);
  // Re-read the stored row: persistEdit's concurrency check compares
  // against the store's own JSON round-trip of the document (a jsonb
  // store may normalize key order), never the in-memory original.
  return await deps.requireOwned(minted.id, ctx);
};

/**
 * The instruction reaches the model ALREADY SCOPED: the fork exists, so this is
 * an ordinary island edit on the pinned component. A failed edit never rolls
 * the fork back — the user keeps the faithful copy and the failure is loud on
 * the result. That holds for THROWN edits too (no model configured, a gated
 * escalation, a provider error): the fork is already persisted, so the gesture
 * returns it with a failure-shaped edit instead of surfacing as an error.
 */
const applyForkInstruction = async (
  deps: Pick<PinsSurfaceDeps, "failedEdit" | "runtime">,
  result: PinForkResult,
  instruction: string,
  ctx: RunContext,
): Promise<PinForkResult> => {
  try {
    const edit = await deps.runtime().edit(
      result.app.id,
      `The remixable host slot "${result.slot}" is already forked into the generated component "${result.componentName}" (its island source is in CURRENT_APP). Apply this change to that component: ${instruction}`,
      ctx,
    );
    return { ...result, app: edit.app, edit };
  } catch (error) {
    return {
      ...result,
      edit: deps.failedEdit(result.app, instruction, [error instanceof Error ? error.message : String(error)]),
    };
  }
};

/**
 * Everything that must hold before a rebase writes anything. Fail-closed by
 * construction: each refusal below is a way a user's remix would otherwise be
 * silently destroyed, so a rebase that cannot vouch for the trail costs one
 * manual remix instead of the remix itself.
 */
const rebasePreflight = async (
  deps: Pick<PinsSurfaceDeps, "config" | "history" | "requireOwned">,
  input: { appId: AppId; slot: string },
  ctx: RunContext,
): Promise<{
  app: AppDocument;
  /** The baseline hash the pin records TODAY, for the audit line. */
  fromBaseHash: string;
  baseline: PinBaseline;
  replayIntents: string[];
  componentName: string;
  forkSource: string;
}> => {
  if (deps.config.model === undefined) {
    throw new VendoError("not-implemented", "generation requires a model");
  }
  const app = await deps.requireOwned(input.appId, ctx);
  const pin = (app.pins ?? []).find(({ slot }) => slot === input.slot);
  if (pin === undefined) {
    throw new VendoError("not-found", `pin not found: ${input.slot}`);
  }
  const baseline = (deps.config.pinBaselines ?? []).find(({ slot }) => slot === input.slot);
  if (baseline === undefined) {
    throw new VendoError("conflict", `pin ${input.slot} has no captured baseline to rebase onto; re-run vendo sync`);
  }
  if (baseline.hash === pin.base) {
    throw new VendoError("conflict", `pin ${input.slot} is not drifted`);
  }
  // Replay rides the tree edit dialect; a graduated http app routes every
  // instruction to the code path, so its trail can no longer replay.
  if (app.ui === "http") {
    throw new VendoError("conflict", `pin ${input.slot} cannot rebase on a served (http) app`);
  }
  const intents = await deps.history.pinIntents(app.id, input.slot);
  // A rebase is a re-fork of the NEW baseline with the trail replayed on top,
  // so it is only ever as honest as the trail. Two things must hold, and each
  // one is a way a user's remix gets silently destroyed:
  //
  // 1. The trail STARTS with the recorded fork — the only row whose content
  //    the re-fork reproduces, since the fork copied the captured baseline
  //    verbatim. An empty trail, or one beginning with anything else, cannot
  //    vouch for what the pinned component holds.
  // 2. Every row AFTER it is a replayable "edit". A "touch" changed the pinned
  //    component while recording only that it did, so the change exists nowhere
  //    but the document this rebase is about to overwrite: skipping past it
  //    resets that work to the pristine host component and reports "rebased".
  //
  // `kind` is absent on rows written before the discriminator existed; those
  // vouch for nothing and replay as nothing, so they fail closed on whichever
  // check they land in. Refusing costs one manual remix; accepting costs the
  // remix itself.
  const unreplayable = intents.slice(1).filter(({ kind }) => kind !== "edit");
  if (intents[0]?.kind !== "fork" || unreplayable.length > 0) {
    throw new VendoError(
      "conflict",
      `pin ${input.slot} has no recorded edit trail to replay; remix the updated component manually`,
      {
        slot: input.slot,
        // Which half refused, because the two are different situations to
        // be in: nothing to replay from, versus a change that was made
        // outside the replayable trail.
        reason: intents[0]?.kind === "fork" ? "unreplayable-trail" : "no-fork-recorded",
        ...(unreplayable.length === 0 ? {} : { unreplayable: unreplayable.map(({ intent }) => intent) }),
      },
    );
  }
  const componentName = pinComponentName(input.slot);
  // ENG-348 — same bar as fork-pin: a baseline the jail could never
  // render must not persist as a "successful" rebase.
  const forkSource = pinForkSource(baseline.source);
  if (!hasDefaultExport(forkSource)) {
    throw new VendoError("conflict", `pin ${input.slot} baseline has no default export and no detectable named component export; export the component from its module and re-run vendo sync`);
  }
  return {
    app,
    fromBaseHash: pin.base,
    baseline,
    replayIntents: intents.slice(1).map(({ intent }) => intent),
    componentName,
    forkSource,
  };
};

// Gesture-owned forking (2026-07-21) — deterministic: the captured
// baseline is copied by the engine and the pin recorded WITHOUT a model
// call. The recorded fork version is intents[0] of the pin's replay
// trail, so rebase() replays exactly the user's later modifications.
const forkPin = async (
  deps: PinsSurfaceDeps,
  input: PinForkInput,
  ctx: RunContext,
): Promise<PinForkResult> => {
  const { config, history, requireOwned, persistEdit, reportLifecycle, rungFor, runtime } = deps;
  const baseline = (config.pinBaselines ?? []).find(({ slot }) => slot === input.slot);
  if (baseline === undefined) {
    throw new VendoError("not-found", `remixable slot "${input.slot}" has no captured baseline; wrap the component in <Remixable> and run vendo sync`);
  }
  const forkOnto = (base: AppDocument): AppDocument => {
    const forked = structuredClone(base);
    // applyPinFork prefixes its issues for the compiler that calls it; a
    // user gesture never saw that op, so the prefix is stripped from the
    // surfaced error. `props` are the wrapper's live props at fork time
    // (2026-08-02 final shape) — they become the pinned node's props.
    const issues = applyPinFork(
      forked,
      { slot: input.slot, ...(input.props === undefined ? {} : { props: input.props }) },
      config.pinBaselines,
    )
      .map((issue) => issue.replace(/^pin fork failed: /, ""));
    if (issues.length > 0) throw new VendoError("conflict", issues.join("; "));
    const validation = validateAppDocument(forked);
    if (!validation.ok) throw new VendoError("validation", validation.error.message);
    return forked;
  };
  const carriesSlotPin = (app: AppDocument): boolean =>
    app.pins?.some((pin) => pin.slot === input.slot) === true;
  // The deterministic fork a dedupe hit describes was recorded when the
  // winning app was minted — intents[0] of the pin's replay trail.
  const dedupedResult = async (existing: AppDocument): Promise<PinForkResult> => {
    const recorded = (await history.pinIntents(existing.id, input.slot))[0];
    return {
      app: existing,
      version: {
        at: recorded?.at ?? new Date().toISOString(),
        intent: recorded?.intent ?? `Remix the host component "${input.slot}"`,
        rung: rungFor(existing),
      },
      slot: input.slot,
      componentName: pinComponentName(input.slot),
    };
  };
  let previous: AppDocument;
  if (input.appId !== undefined) {
    previous = await requireOwned(input.appId, ctx);
    if (previous.tree?.formatVersion !== VENDO_TREE_FORMAT) {
      throw new VendoError("conflict", "a pin fork requires a vendo-genui/v2 tree app");
    }
  } else {
    // Idempotent per (subject, slot) — the appId-less gesture dedupes
    // server-side: when this subject already has an app whose pins name
    // the slot, that app IS the fork, and it is returned instead of
    // minting a duplicate (a double-tap can never mint two; the UI
    // latch is cosmetic). A riding instruction is dropped — the tap
    // that created the fork already carries it, and replaying it here
    // would apply the same edit twice.
    // The OLDEST matching row, so every dedupe path (this pre-check and
    // the post-persist re-check below) converges on the same winner.
    const existing = (await runtime().list(ctx)).filter(carriesSlotPin).at(-1);
    if (existing !== undefined) return dedupedResult(existing);
    previous = await mintForkBase(deps, baseline, input.slot, ctx, forkOnto);
  }
  const working = forkOnto(previous);
  const version: VersionEntry = {
    at: new Date().toISOString(),
    intent: `Remix the host component "${input.slot}"`,
    rung: rungFor(working),
  };
  const persisted = await persistEdit(previous, working, version, ctx.principal.subject, [input.slot], { pinIntentKind: "fork" });
  await reportLifecycle("pin-fork", persisted.id, ctx, {
    slot: input.slot,
    baseHash: baseline.hash,
  });
  if (input.appId === undefined) {
    // The pre-mint dedupe is list-then-put: two concurrent gestures can
    // both find nothing and mint two apps. Close the race after the
    // persist — list again, and when an OLDER app also carries the
    // slot's pin, delete the just-minted row and return the older one.
    // Both racers pick the same winner: list order is deterministic
    // (createdAt, then id), so only the loser deletes itself.
    const oldest = (await runtime().list(ctx)).filter(carriesSlotPin).at(-1);
    if (oldest !== undefined && oldest.id !== persisted.id) {
      await runtime().delete(persisted.id, ctx);
      return dedupedResult(oldest);
    }
  }
  const result: PinForkResult = {
    app: persisted,
    version: { ...version },
    slot: input.slot,
    componentName: pinComponentName(input.slot),
  };
  const instruction = input.instruction?.trim();
  if (instruction === undefined || instruction.length === 0) return result;
  return applyForkInstruction(deps, result, instruction, ctx);
};

const rebasePin = async (
  deps: PinsSurfaceDeps,
  input: { appId: AppId; slot: string },
  ctx: RunContext,
): Promise<PinRebaseResult> => {
  const { apps, requireOwned, persistEdit, assembleEdit, reportLifecycle, rungFor } = deps;
  const { app, fromBaseHash, baseline, replayIntents, componentName, forkSource } =
    await rebasePreflight(deps, input, ctx);
  const rebased: AppDocument = structuredClone(app);
  rebased.components = { ...(rebased.components ?? {}), [componentName]: forkSource };
  rebased.pins = (rebased.pins ?? []).map((candidate) => candidate.slot === input.slot
    ? { ...candidate, base: baseline.hash }
    : candidate);
  const replayed: string[] = [];
  const failedRebase = async (intent: string, issues: string[], remaining: string[]): Promise<PinRebaseResult> => {
    // Every replay step is a real write through the one builder, so an
    // abandoned rebase has to put the app back exactly as it was — a
    // half-replayed trail on a new baseline is neither the old remix nor
    // the new one.
    await apps.put(appRecordInput(app, ctx.principal.subject, (await apps.get(app.id).then(
      (record) => record === null ? false : rowFromRecord(record).enabled,
    ).catch(() => false)))).catch(() => undefined);
    return {
      status: "failed",
      slot: input.slot,
      baseHash: baseline.hash,
      replayed: [...replayed],
      failed: { intent, issues },
      remaining,
    };
  };
  // Replay rides the ordinary edit path: the recorded intents are the
  // user's own words, and re-saying them to the builder is what replaying
  // them MEANS. The re-forked baseline is written FIRST so each replayed
  // instruction lands on the app as the previous one left it — the builder
  // reads the app's own document, which is the whole point of there being
  // one writer.
  //
  // KNOWN, and accepted for now: a replay is a real edit, so it records its
  // own pin intent and the trail grows by one row per replayed instruction.
  // A second rebase therefore replays each instruction twice. Harmless for
  // an idempotent edit ("make it green" twice is green), and the alternative
  // — recording the replays as `touch` — would make the NEXT rebase read the
  // trail as unreplayable and reset the remix to the pristine component,
  // which is the worse failure this discriminator exists to prevent.
  let working = await persistEdit(app, rebased, {
    at: new Date().toISOString(),
    intent: `Re-fork ${input.slot} onto the updated host component`,
    rung: rungFor(rebased),
  }, ctx.principal.subject, [], { pinIntentKind: "fork" });
  for (const [index, intent] of replayIntents.entries()) {
    const replayedEdit = await assembleEdit(app.id, intent, ctx);
    const remaining = replayIntents.slice(index + 1);
    if (replayedEdit.kind !== "assembled") {
      return failedRebase(
        intent,
        replayedEdit.kind === "escalate"
          ? ["the replayed intent asked for a build, which a rebase cannot run"]
          : replayedEdit.issues,
        remaining,
      );
    }
    const next = replayedEdit.app;
    const survived = (next.pins ?? []).some((candidate) =>
      candidate.slot === input.slot && candidate.base === baseline.hash)
      && next.components?.[componentName] !== undefined;
    if (!survived) {
      return failedRebase(intent, ["replayed intent removed the rebased pin or its component source"], remaining);
    }
    working = next;
    replayed.push(intent);
  }
  const validation = validateAppDocument(working);
  if (!validation.ok) {
    throw new VendoError("validation", validation.error.message);
  }
  const version: VersionEntry = {
    at: new Date().toISOString(),
    intent: `Rebase remixed ${input.slot} onto the updated host component`,
    rung: rungFor(working),
  };
  // The rebase version appends NO pin intent of its own: its content is
  // exactly the replayed trail on the new baseline, and replaying a
  // "rebase" instruction through the model on a future rebase would be
  // meaningless.
  // Re-read: every replayed step already landed, so the row as it stands
  // IS this rebase's baseline — persisting against the pre-rebase document
  // would read as a concurrent change.
  const current = await requireOwned(app.id, ctx);
  const persisted = await persistEdit(current, working, version, ctx.principal.subject, [], {});
  await reportLifecycle("pin-rebase", app.id, ctx, {
    slot: input.slot,
    fromBaseHash,
    toBaseHash: baseline.hash,
    replayedIntents: replayed.length,
  });
  return {
    status: "rebased",
    app: persisted,
    version: { ...version },
    slot: input.slot,
    baseHash: baseline.hash,
    replayed,
  };
};

export const createPinsSurface = (deps: PinsSurfaceDeps): AppsRuntime["pins"] => ({
  fork: (input, ctx) => forkPin(deps, input, ctx),
  rebase: (input, ctx) => rebasePin(deps, input, ctx),
});
