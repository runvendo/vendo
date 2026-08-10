/**
 * The ONE document write and the trail it leaves: the version append, the
 * optimistic-concurrency bracket, the §9.9 announcement, and the intent slots
 * that carry an `edit`'s own words into the save `authored` makes for it.
 *
 * Lifted out of `createApps` unchanged.
 */
import {
  VENDO_TREE_FORMAT,
  VendoError,
  safeErrorMessage,
  type AppId,
  type RunContext,
} from "@vendoai/core";
import {
  bundleOf,
  type AppDocument,
  type ScreenAssembler,
  type Tree,
} from "../../contract/index.js";
import { appMemoryBrief } from "./app-memory.js";
import type { PinIntentKind } from "./history.js";
import {
  appRecordInput,
  enabledAfterDocumentEdit,
  rowFromRecord,
  withoutSession,
  type AppRecordWrite,
} from "./persistence.js";
import { detectPinDrift, pinComponentName } from "../remix/pins.js";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";
import { NO_ASSEMBLER, NOTHING_RENDERABLE } from "../doors/build-messages.js";
import type { EditResult, VersionEntry } from "../runtime/types.js";

export const rungFor = (
  app: AppDocument,
  declared?: VersionEntry["rung"],
): VersionEntry["rung"] => {
  // execution-v2 Wave 4 — a machine-served surface is layer 3 (the layer ladder);
  // rung 4 is a served document with no machine (a de-graduated doc), which has
  // no surface anywhere — see `open`'s http branch.
  if (app.ui === "http") return app.machine !== undefined ? 3 : 4;
  // execution-v2 — a machine (Wave 1 Lane B) is layer 2; presence, never a
  // stored rung, is the source of truth.
  if (app.machine !== undefined) return declared === 3 ? 3 : 2;
  return 1;
};

const pinnedSubtree = (app: AppDocument, componentName: string): unknown[] => {
  if (app.tree?.formatVersion !== VENDO_TREE_FORMAT) return [];
  const tree = app.tree as unknown as Tree;
  const included = new Set(tree.nodes.filter((node) => node.component === componentName).map((node) => node.id));
  const pending = [...included];
  while (pending.length > 0) {
    const id = pending.pop();
    const node = tree.nodes.find((candidate) => candidate.id === id);
    for (const child of node?.children ?? []) {
      if (included.has(child)) continue;
      included.add(child);
      pending.push(child);
    }
  }
  return tree.nodes.filter(({ id }) => included.has(id));
};

/** One component's source, or undefined when the document has no such entry.
 *  Absence stays distinct from an empty source, which is what the raw `!==`
 *  compared before bundles existed. */
const sourceOf = (document: AppDocument, componentName: string): string | undefined => {
  const entry = document.components?.[componentName];
  return entry === undefined ? undefined : bundleOf(entry).source;
};

export const touchedPinSlots = (previous: AppDocument, next: AppDocument): string[] => {
  const previousPins = new Map((previous.pins ?? []).map((pin) => [pin.slot, pin]));
  return (next.pins ?? []).flatMap((pin) => {
    const prior = previousPins.get(pin.slot);
    if (prior?.base !== pin.base) return [pin.slot];
    const componentName = pinComponentName(pin.slot);
    // Through `bundleOf`, not on the raw entry: a bare source string compares by
    // VALUE but a bundle compares by identity, so a raw `!==` would report every
    // pinned slot as touched on every edit the moment a bundle is stored.
    if (sourceOf(previous, componentName) !== sourceOf(next, componentName)) return [pin.slot];
    // Subtree serialization intentionally over-reports reordered nodes as touched.
    return JSON.stringify(pinnedSubtree(previous, componentName)) === JSON.stringify(pinnedSubtree(next, componentName))
      ? []
      : [pin.slot];
  });
};

/** A document without its id, the shape every generation module speaks. */
export const withoutId = (app: AppDocument): Omit<AppDocument, "id"> => {
  const { id: _id, ...document } = structuredClone(app);
  return document;
};

const createEditResults = (deps: Pick<AppsRuntimeContext, "config">) => {
  const { config } = deps;
  // 06-apps §8 — every edit result over a drifted app carries the drift report,
  // so an agent or host editing a stale fork hears about it at edit time.
  const withPinDrift = (result: EditResult): EditResult => {
    const driftedPins = detectPinDrift(result.app, config.pinBaselines ?? []);
    return driftedPins.length === 0 ? result : { ...result, driftedPins };
  };

  const failedEdit = (
    app: AppDocument,
    instruction: string,
    issues: string[],
    retryable = true,
  ): EditResult => withPinDrift({
    app: structuredClone(app),
    version: {
      at: new Date().toISOString(),
      intent: instruction,
      rung: rungFor(app),
    },
    issues: [...issues],
    failure: {
      code: "edit-rejected",
      retryable,
      message: retryable
        ? "Edit was not applied. Retry vendo_make with the same `app` and a narrower request; do not rebuild the app."
        : "Edit was not applied and cannot be retried until the reported blocker is resolved.",
    },
  });

  return { withPinDrift, failedEdit };
};

const createEditNotices = (deps: Pick<AppsRuntimeContext, "config" | "history">) => {
  const { config, history } = deps;
  /**
   * Build contract §9.9 — the ONE announcement every change to what an app IS
   * passes through, so lane H's sponsorship invalidation hears about a
   * third-party change without a second write path to police. The change has
   * ALREADY landed: a listener that throws must never unwind it.
   */
  const reportDocumentEdit = async (
    previous: AppDocument,
    next: AppDocument,
    subject: string,
  ): Promise<void> => {
    if (config.onDocumentEdit === undefined) return;
    try {
      await config.onDocumentEdit(previous, next, subject);
    } catch (error) {
      console.warn(`[vendo] onDocumentEdit hook failed for ${next.id}: ${safeErrorMessage(error)}`);
    }
  };

  /**
   * The version an append already spent, deleted because the write it was
   * appended FOR never landed. Leaving it would put a version in the trail for
   * a state that never became the past — and its snapshot predates the
   * concurrent change a refusal just preserved. Cleanup failure is logged,
   * never thrown — the refusal is what the caller must hear about.
   */
  const discardVersion = async (appId: AppId, versionId: string): Promise<void> => {
    try {
      await history.discard(appId, versionId);
    } catch (error) {
      console.error(`[vendo] a refused write left a stale version behind (${appId}): ${safeErrorMessage(error)}`);
    }
  };

  /** The 50-version cap, applied once the write its newest version records has
   *  LANDED — see `AppHistoryAccess.prune` (history.ts) for why it cannot live
   *  inside the append. Failure is logged, never thrown: the save is real, and one
   *  entry over the cap is not worth turning it into an error. */
  const pruneHistory = async (appId: AppId): Promise<void> => {
    try {
      await history.prune(appId);
    } catch (error) {
      console.error(`[vendo] history for ${appId} could not be trimmed to its cap: ${safeErrorMessage(error)}`);
    }
  };

  return { reportDocumentEdit, discardVersion, pruneHistory };
};

const createEditPersist = (
  deps: Pick<AppsRuntimeContext, "apps" | "history">
    & Pick<ReturnType<typeof createEditNotices>, "reportDocumentEdit" | "discardVersion" | "pruneHistory">,
) => {
  const { apps, history, reportDocumentEdit, discardVersion, pruneHistory } = deps;
  const persistEdit = async (
    previous: AppDocument,
    app: AppDocument,
    version: VersionEntry,
    subject: string,
    pinSlots?: readonly string[],
    options: {
      /** An edit that AUTHORED the trigger arms it in the same write (the
       *  server lane's automation path); every other edit keeps the
       *  disarm-on-trigger-change rule below. */
      armTrigger?: boolean;
      /** `"fork"` on the fork gesture's own version — the ONE pin intent that
       *  vouches for the pinned source having started as the captured baseline,
       *  which is what `pins.rebase` replays the rest of the trail onto. Every
       *  other write records a replayable `"edit"`. */
      pinIntentKind?: PinIntentKind;
    } = {},
  ): Promise<AppDocument> => {
    // Build contract §9.5 — the ROW's subject, which for a promoted app is the
    // org id, not the editor. The routing door pins `WHERE id AND subject`, so
    // writing the editor here would silently lose every org edit; `can(editor)`
    // upstream is what authorized this write, and the row keeps its owner.
    const rowSubject = (await apps.get(previous.id))?.refs?.subject ?? subject;
    // Best-effort optimistic concurrency. The core StoreAdapter seam (01-core §12) has
    // no compare-and-swap or transactions, so a narrow TOCTOU window between the final
    // check and the put remains — closing it fully needs a store-level revision column
    // (a store-block follow-up). This catches the common double-edit races.
    const assertCurrent = async (): Promise<boolean> => {
      const current = await apps.get(previous.id);
      const row = current === null ? null : rowFromRecord(current);
      if (row === null
        || row.subject !== rowSubject
        || JSON.stringify(row.doc) !== JSON.stringify(previous)) {
        throw new VendoError("conflict", `app changed during edit: ${previous.id}`);
      }
      return row.enabled;
    };
    await assertCurrent();
    // Lane E — egressApproved is grant state, written ONLY by the egress
    // approval flow: an engine- or model-authored edit must never mint or
    // widen it (same rule as model-forged venue/drift fields above). Pin it
    // to the stored document's value.
    if (previous.egressApproved === undefined) {
      delete app.egressApproved;
    } else {
      app.egressApproved = [...previous.egressApproved];
    }
    // Same rule, same reason: the memory is written by the memory door alone, so
    // an edit carries the STORED one across rather than whatever the generated
    // document happens to hold (which, on a rebuild, is nothing).
    if (previous.memory === undefined) {
      delete app.memory;
    } else {
      app.memory = structuredClone(previous.memory);
    }
    const versionId = await history.append(
      app.id,
      previous,
      version,
      pinSlots ?? touchedPinSlots(previous, app),
      options.pinIntentKind,
    );
    let appRow: AppRecordWrite;
    try {
      const wasEnabled = await assertCurrent();
      // A changed trigger must be re-armed — enable() re-captures and re-mints trigger state.
      const enabled = options.armTrigger === true && (app.triggers ?? []).length > 0
        ? true
        : enabledAfterDocumentEdit(previous, app, wasEnabled);
      appRow = appRecordInput(app, rowSubject, enabled);
      await apps.put(appRow);
    } catch (error) {
      // The version above records a state that never became the past — see
      // discardVersion. The refusal is re-thrown unchanged.
      await discardVersion(app.id, versionId);
      throw error;
    }
    // The write landed, so that version is real history now and the cap applies
    // to it — see pruneHistory for why this cannot happen inside the append.
    await pruneHistory(app.id);
    await reportDocumentEdit(previous, appRow.data.doc, subject);
    // A legacy row's transcript never rides a document out of the runtime. One
    // rule, every path (get/list/fork strip it too), so what an edit
    // returns is exactly what a list returns.
    return withoutSession(structuredClone(appRow.data.doc));
  };

  return { persistEdit };
};

const createEditIntents = () => {
  /**
   * The person's own words for a save THIS runtime asked the assembler for.
   *
   * `authored` is the one write path now — a runtime edit is a screen agent
   * opening the app's document, rewriting it and saving it, which is the same
   * commit any other author makes. Without this the recorded version for every
   * edit would read "Saved app.vendo" and `pins.rebase` would find a trail of
   * unreplayable `touch` rows where the user's instructions used to be.
   *
   * Set for exactly the duration of one `assembleEdit`, keyed by app so two
   * concurrent edits of different apps cannot read each other's intent.
   */
  const editIntents = new Map<AppId, string>();

  /**
   * The version row an edit's own save APPENDED, keyed by app — the return leg
   * of `editIntents`.
   *
   * The row is written where the save happens (`authored`, the one write path),
   * and `edit` reports it verbatim rather than stamping a second `new Date()`:
   * two clock reads agree only inside one millisecond, so the version handed to
   * the caller otherwise differs from the one history holds whenever the two
   * straddle a tick.
   *
   * Keyed by app, like `editIntents` — so two OVERLAPPING edits of one app share
   * a slot, and the WORDS decide whose row it is (`takeEditVersion`): an edit
   * takes the entry only when its intent is the instruction that edit was given,
   * and otherwise leaves the sibling's row where it is and stamps its own
   * version exactly as this door did before any row was captured. Both misses
   * degrade to that stamp — the millisecond skew this fix removes in the
   * ordinary case — and neither can hand a caller someone else's version.
   */
  const editVersions = new Map<AppId, VersionEntry>();

  /**
   * Why an edit's own save did NOT land, keyed by app — the other return leg of
   * `editIntents`, and the only one that can say the edit failed.
   *
   * A refused save degrades rather than throws (the file is on screen, it just
   * is not in the store), and the assembler sits between that save and this
   * runtime, so `authored`'s return value cannot carry the refusal back to
   * `edit`. Without this, `assembleEdit` re-reads the row, finds the PRE-edit
   * document, and reports it as the edit — a success receipt for a change that
   * never happened.
   *
   * Keyed by app and matched on the WORDS, exactly like `editVersions`, so two
   * overlapping edits of one app cannot take each other's refusal.
   */
  const editRefusals = new Map<AppId, { intent: string; reason: string }>();

  /** THIS edit's refusal, or nothing. See {@link editRefusals}. */
  const takeEditRefusal = (appId: AppId, instruction: string): string | undefined => {
    const recorded = editRefusals.get(appId);
    if (recorded?.intent !== instruction) return undefined;
    editRefusals.delete(appId);
    return recorded.reason;
  };

  /**
   * THIS edit's captured row, or nothing.
   *
   * The intent match is the correlation: `edit` reports a version, and the only
   * version it may report is one recorded under the words it was asked to carry
   * out. A row belonging to an overlapping edit of the same app is left in the
   * map for that edit to take.
   */
  const takeEditVersion = (appId: AppId, instruction: string): VersionEntry | undefined => {
    const recorded = editVersions.get(appId);
    if (recorded?.intent !== instruction) return undefined;
    editVersions.delete(appId);
    return recorded;
  };

  return { editIntents, editVersions, editRefusals, takeEditRefusal, takeEditVersion };
};

const createEditAssembler = (
  deps: Pick<AppsRuntimeContext, "config" | "apps" | "requireOwned">
    & Pick<ReturnType<typeof createEditIntents>,
      "editIntents" | "editVersions" | "editRefusals" | "takeEditRefusal">,
) => {
  const { config, apps, requireOwned } = deps;
  const { editIntents, editVersions, editRefusals, takeEditRefusal } = deps;
  /**
   * ONE instruction through the ONE builder.
   *
   * There is no second engine: the assembler opens the app's own `app.vendo`,
   * rewrites it and saves it, and the save lands through `authored` — the real
   * store write, the real floor, the real paint. So this returns nothing but the
   * row as it stands afterwards, because the row IS the answer.
   *
   * `unavailable`, a throw, and an unfilled slot are the same honest failure
   * `vendo_make` gives a create: a deployment that composed no assembler cannot
   * change an app, and pretending otherwise is how a composition bug ships.
   */
  const assembleEdit = async (
    appId: AppId,
    instruction: string,
    ctx: RunContext,
  ): Promise<
    | { kind: "assembled"; app: AppDocument }
    /** The CHANGE needs the builder — the escalation ladder, from an app that
     *  already exists. The document is untouched and still serving. */
    | { kind: "escalate" }
    | { kind: "failed"; issues: string[] }
  > => {
    if (config.screen === undefined) {
      return { kind: "failed", issues: [NO_ASSEMBLER] };
    }
    // The app's MEMORY leads the brief, for the same reason it leads the
    // in-box builder's (`editServerViaBox`): the document on screen cannot say
    // which of its shapes were asked for and which are incidental, so an editor
    // that never read it "fixes" the filter the person asked for. Composed here
    // rather than duplicated — `appMemoryBrief` is the one writer of this block.
    const before = await apps.get(appId).catch(() => null);
    const memory = appMemoryBrief(before === null ? undefined : rowFromRecord(before).doc.memory);
    editIntents.set(appId, instruction);
    // Kept even though `takeEditVersion` matches on the words: an entry no edit
    // ever took (an assembler that saved and then reported unavailable, a
    // `rebind` inside the ladder) would otherwise sit here until some later edit
    // of this app said exactly the same thing and reported that OLD row as its
    // own. Clearing can only cost a concurrent edit its captured row, and losing
    // a row means stamping the version the way this door always did.
    editVersions.delete(appId);
    editRefusals.delete(appId);
    let outcome: Awaited<ReturnType<ScreenAssembler["assemble"]>>;
    try {
      outcome = await config.screen.assemble({
        appId,
        request: memory === undefined ? instruction : `${memory}\n\n${instruction}`,
      }, ctx);
    } catch (error) {
      return { kind: "failed", issues: [safeErrorMessage(error)] };
    } finally {
      editIntents.delete(appId);
    }
    if (outcome.kind === "escalate") return { kind: "escalate" };
    if (outcome.kind === "unavailable") return { kind: "failed", issues: [outcome.why] };
    // The assembler says it saved, and the STORE may have refused that save (see
    // `editRefusals`). The row below would then read back the pre-edit document
    // and this door would report it as the edit.
    const refused = takeEditRefusal(appId, instruction);
    if (refused !== undefined) return { kind: "failed", issues: [refused] };
    // Through `requireOwned`, so what comes back is the same access-checked
    // document every other door hands out — the row is the answer and it must
    // read identically wherever it is read.
    const stored = await requireOwned(appId, ctx).catch(() => undefined);
    if (stored === undefined) return { kind: "failed", issues: [NOTHING_RENDERABLE] };
    return { kind: "assembled", app: stored };
  };

  return { assembleEdit };
};

/** The edit-journal slice of `createApps`' closure. */
export const createEditJournal = (
  deps: Pick<AppsRuntimeContext, "config" | "apps" | "history" | "requireOwned">,
) => {
  const results = createEditResults(deps);
  const notices = createEditNotices(deps);
  const persist = createEditPersist({ ...deps, ...notices });
  const intents = createEditIntents();
  const assembler = createEditAssembler({ ...deps, ...intents });
  return { rungFor, ...results, ...notices, ...persist, ...intents, ...assembler };
};
