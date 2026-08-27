/**
 * The doors that CHANGE a stored app: the files-first save every author's
 * `app.tsx` lands through, the app's own source commit, the one instruction
 * door, its memory, and its cron.
 *
 * Lifted out of `createApps` unchanged.
 */
import {
  VENDO_APP_FORMAT,
  log,
  VendoError,
  safeErrorMessage,
  seedComponentName,
  type AppId,
  type RunContext,
} from "@vendoai/core";
import {
  SCREEN_FILE,
  bundleOf,
  type AppDocument,
} from "../../contract/index.js";
import { rememberedMemory } from "../persistence/app-memory.js";
import { commitApp, inlineSourceFile } from "../persistence/app-source.js";
import { rungFor } from "../persistence/edit-journal.js";
import type { AppData } from "../../contract/index.js";
import { APPS_COLLECTION, appRecordInput, onAppRow, rowFromRecord } from "../persistence/persistence.js";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";
import type { AppsRuntime, EditResult, VersionEntry } from "../runtime/types.js";



/** What a refused save leaves behind — see the three intent slots in
 *  `edit-journal.ts`. The app is on screen, it just is not in the list. */
const createRefusedSaveRecorder = (
  deps: Pick<AppsRuntimeContext, "editIntents" | "editRefusals" | "editVersions" | "discardVersion">,
) => {
  const { editIntents, editRefusals, editVersions, discardVersion } = deps;
  return async (appId: AppId, error: unknown, appended: string | undefined): Promise<void> => {
    // The same degradation create takes on a refused write: the app is on
    // screen, it just is not in the list. Never silent — and never a reason
    // to withhold the data the person can already see.
    const reason = safeErrorMessage(error);
    log({
      code: "apps.edit-not-saved",
      level: "error",
      message: `[vendo] app not saved (${appId}): the harness wrote it as a file but it did not land — ${reason}`,
    });
    // …and when the save was an EDIT's, the refusal is that edit's answer:
    // the row still holds the pre-edit document, so `assembleEdit` reading
    // it back would report an unchanged app as the change (`editRefusals`).
    const refusedIntent = editIntents.get(appId);
    if (refusedIntent !== undefined) editRefusals.set(appId, { intent: refusedIntent, reason });
    // …and a refused save records no version: the appended version's snapshot
    // predates the concurrent edit the refusal just preserved, so leaving it
    // would put a lie in the trail (see discardVersion).
    if (appended !== undefined) await discardVersion(appId, appended);
    // …and a discarded version is not history, so it is not this edit's
    // answer either.
    editVersions.delete(appId);
  };
};

const createAuthoredSaver = (
  deps: Pick<AppsRuntimeContext,
    "engine" | "history" | "pruneHistory" | "reportLifecycle" | "reportDocumentEdit"
    | "editIntents" | "editVersions" | "discardVersion" | "editRefusals">,
) => {
  const { engine, history, pruneHistory, reportLifecycle, reportDocumentEdit } = deps;
  const { editIntents, editVersions } = deps;
  const recordRefusedSave = createRefusedSaveRecorder(deps);
  return async (
    input: { appId: AppId; document: AppDocument; previous: AppDocument | undefined; row: AppData | null },
    ctx: RunContext,
  ): Promise<void> => {
    const { document, previous, row } = input;
    /** The version this save appended, while its write has not landed yet. */
    let appended: string | undefined;
    try {
      /** Whether this save is a change at all — the history entry and the §9.9
       *  announcement below are both owed only by a save that changes the app. */
      let changed = false;
      let enabled = false;
      if (previous !== undefined) {
        // `persistEdit`'s `assertCurrent` bracket, in the shape a files-first
        // save can take it. `document` carries the baseline's own history
        // forward (trigger, pins, storage, machine, description), so a put
        // computed over a row that changed in the window would silently REVERT
        // an `edit()` that landed there rather than merely ordering after it.
        // Best-effort for persistEdit's reason (no revision on the store seam),
        // and it cannot conflict with a run of same-turn saves: every save
        // re-reads its own baseline. Only ever re-reads a row this caller was
        // already authorized to read.
        const assertCurrent = async (): Promise<boolean> => {
          const current = await engine.get(APPS_COLLECTION, input.appId);
          const stored = current === null ? null : rowFromRecord(current);
          if (stored === null
            // The subject too, for persistEdit's reason: a promote that landed
            // in the window moved the row to an org, and re-writing the stale
            // owner would lose the app out of it.
            || stored.subject !== row?.subject
            || JSON.stringify(stored.doc) !== JSON.stringify(previous)) {
            throw new VendoError("conflict", `app changed under this save: ${input.appId}`);
          }
          return stored.enabled;
        };
        await assertCurrent();
        // The version this path recorded none of: the state the save replaces,
        // appended before the write lands, exactly as persistEdit does it. A
        // re-save that changed nothing is not a version — it would spend one of
        // the 50 capped slots on the state the app is already in.
        changed = JSON.stringify(previous) !== JSON.stringify(document);
        if (changed) {
          // The person's own words when THIS runtime asked for the save
          // (`edit`, and the trail `pins.rebase` replays); "Saved app.tsx"
          // for every other author, which is all a bare file save can say.
          const intent = editIntents.get(input.appId);
          const entry: VersionEntry = {
            at: new Date().toISOString(),
            intent: intent ?? `Saved ${SCREEN_FILE}`,
            rung: rungFor(document),
          };
          // ONE clock read for this save: when the save is an `edit`'s, that
          // door reports this very row (see `editVersions`).
          if (intent !== undefined) editVersions.set(input.appId, entry);
          appended = await history.append(input.appId, previous, entry);
        }
        // Asserted a SECOND time, because the append is itself a store round
        // trip and the first check alone leaves it inside the TOCTOU window.
        enabled = await assertCurrent();
      }
      const appRow = appRecordInput(
        document,
        // §9.5 — a promoted app's row subject is the ORG id; the editor check
        // above is what authorized this write, and the row keeps its owner.
        row?.subject ?? ctx.principal.subject,
        enabled,
        "box",
      );
      await engine.put(APPS_COLLECTION, appRow);
      // The write landed, so the version above is real history now: whatever
      // the announcements below do, it must not be cleaned up — and the cap
      // applies to it (pruneHistory).
      appended = undefined;
      await pruneHistory(input.appId);
      if (previous === undefined) {
        await reportLifecycle("create", document.id, ctx);
      } else if (changed) {
        // §9.9 — the ONE announcement every change to what an app IS passes
        // through (see reportDocumentEdit). A files-first rewrite changes the
        // app while leaving `trigger` verbatim, so the intent hash a sponsorship
        // was minted over is unchanged: without this, a third party's rewrite
        // leaves sponsorship ACTIVE and the automation keeps firing on the
        // sponsor's authority against code the sponsor never saw, and a
        // sponsor's own rename changes the hash with no re-bind. Partial saves
        // included — what the store holds is what fires. An identical re-save is
        // announced on neither half: invalidation is terminal, so announcing it
        // would kill a live sponsorship for nothing.
        await reportDocumentEdit(previous, appRow.data.doc, ctx.principal.subject);
      }
    } catch (error) {
      await recordRefusedSave(input.appId, error, appended);
    }
  };
};


/**
 * The remix SEAT, carrying the person's own screen.
 *
 * A seeded app's seat is what SHIPS into the host page in place of the captured
 * component, and the ship-diff a human approver reads is that seat against the
 * baseline (`computeShipDiff`). A screen save that left the seat alone showed the
 * approver an empty diff while the person's real change shipped unreviewed.
 *
 * Only the SOURCE is the person's. `origin`, `sourceImports`, `subSources`,
 * `sampleProps` and `styleSheets` are the captured host module's own plumbing and
 * are what make the fork render in the host page at all
 * (`attachSeedFurnishings`), so the stored bundle rides through and only its
 * source is replaced. Only the SEED seat, only on an app that carries a seed, and
 * only a seat that already exists: a generated island is the engine's, and a seat
 * is never invented here.
 */
const withScreenInSeat = (document: AppDocument, source: string): AppDocument => {
  const seat = document.seed === undefined ? undefined : seedComponentName(document.seed.component);
  const entry = seat === undefined ? undefined : document.components?.[seat];
  if (seat === undefined || entry === undefined) return document;
  return {
    ...document,
    components: { ...document.components, [seat]: { ...bundleOf(entry), source } },
  };
};

/**
 * The document a painted COMPONENT screen leaves behind — `authored`'s job for the
 * artifact that has no wire document.
 *
 * The screen IS the app, so it is stored as the app's own source file, inline: the
 * one place that reads it back reads inline text only (`open()`, which re-runs it),
 * because a blob fetch would be a second way to read an app.
 *
 * No tree is written, because a screen's tree is what RENDERING it produces —
 * storing the snapshot the gauntlet happened to take would put yesterday's numbers
 * in the person's list and call them today's. Everything else the app already
 * carried rides through untouched, exactly as `authoredDocument` does it: a save is
 * not a generation.
 */
const screenDocument = (
  input: { appId: AppId; name: string; source: string },
  previous: AppDocument | undefined,
  /** An assembler is running for this app, so this save is a BUILD's. */
  building: boolean,
): AppDocument => {
  const document = withScreenInSeat({
    ...(previous === undefined ? { format: VENDO_APP_FORMAT } : structuredClone(previous)),
    // The window a build paints inside, which is not over when it first paints:
    // the reviewer pass and its repair round run after (`assemble`,
    // screen-agent.ts). `building` holds the row back from mounting until the
    // assembler returns and settles it.
    //
    // Keyed on the BUILD, never on the row being new: a ✦ remix's row is written
    // by the gesture before its screen exists, and an edit's row always
    // pre-exists, so "no previous document" gated the create path alone and left
    // the number-changing repair the person actually watches — the remix — mounting
    // its draft (live, 2026-08-15). `??` is what makes the stamp the build's
    // first paint rather than its latest. A harness writing `app.tsx` straight
    // through the workspace is untouched: no build behind that save to be
    // unfinished.
    ...(building ? { building: previous?.building ?? new Date().toISOString() } : {}),
    id: input.appId,
    name: input.name,
    ui: "tree",
    source: { ...previous?.source, [SCREEN_FILE]: inlineSourceFile(input.source) },
  }, input.source);
  // A screen that painted is an app that works, so a terminal build failure
  // recorded before it cannot outlive it: `open()` serves a `buildFailed` row as
  // a failure and `list()` skips it, so a late success would otherwise leave the
  // app invisible and unopenable forever.
  delete document.buildFailed;
  return document;
};

/**
 * The row a painted COMPONENT screen gets, on EVERY save that paints.
 *
 * The gauntlet's own `ok` is the seam's paint gate, so this is the one place that
 * knows a screen may become the app — which makes it the one place that may store
 * it. `commitSource`'s generic workspace diff deliberately does not
 * (`SEAM_OWNED` in app-source.ts): it cannot tell a passing screen from a refused
 * one, and it landed the bytes of screens the floor would not render.
 *
 * A re-save is a real save, through the SAME versioned saver every screen uses: the
 * CAS bracket, the version filed under the person's own words, the §9.9
 * announcement. One artifact must not get a weaker contract than the other — this
 * used to refuse to rewrite a row it had not created, so a component app's whole
 * edit history was empty.
 *
 * Its refusals are `authored`'s, for `authored`'s reason: `/user/**` is its
 * subject's at every level, so a harness can write another person's app id into its
 * own mount.
 */
const createAuthoredScreenDoor = (
  deps: Pick<AppsRuntimeContext, "engine" | "holds" | "buildingNow"> & {
    saveAuthoredDocument: ReturnType<typeof createAuthoredSaver>;
  },
): AppsRuntime["authoredScreen"] => {
  const { engine, holds, buildingNow, saveAuthoredDocument } = deps;
  // The BASELINE READ is inside the turn, not before it: the document below is
  // computed over `row`, and `saveAuthoredDocument` refuses if the stored row
  // stopped matching it. Taking the turn after the read would leave exactly the
  // window that refusal exists to catch (`onAppRow`).
  return async (input, ctx) => onAppRow(input.appId, async () => {
    const record = await engine.get(APPS_COLLECTION, input.appId);
    const row = record === null ? null : rowFromRecord(record);
    if (row !== null && !await holds(input.appId, ctx, "editor", record)) return;
    // `open()` re-runs the stored screen through this same gauntlet, so this fires
    // on every READ of a screen app too. A save whose screen is already the stored
    // screen changes nothing about the app: writing anyway would spend one of the
    // 50 version slots on the state the app is already in, and would put the
    // person's screen back in a seat a `reseed` deliberately made pristine again.
    if (row?.doc.source?.[SCREEN_FILE]?.text === input.source) return;
    await saveAuthoredDocument({
      appId: input.appId,
      document: screenDocument(input, row?.doc, buildingNow(input.appId)),
      previous: row?.doc,
      row,
    }, ctx);
  });
};

/**
 * Why a painted screen's save left NO row — `authoredScreen`'s opposite half.
 *
 * Only ever an EDIT's answer. The floor refuses on every path that paints,
 * including the paint `open()` runs over a stored screen, where nothing was being
 * saved at all; the intent is what says a save was in flight (`editIntents`).
 * Without this the assembler re-reads the row, finds the PRE-edit document and
 * reports it as the change — a clean receipt for an edit the floor rejected.
 */
const createRefusedScreenDoor = (
  deps: Pick<AppsRuntimeContext, "editIntents" | "editRefusals" | "editVersions" | "discardVersion">,
): AppsRuntime["refusedScreen"] => {
  const recordRefusedSave = createRefusedSaveRecorder(deps);
  return async (input) => {
    if (deps.editIntents.get(input.appId) === undefined) return;
    await recordRefusedSave(
      input.appId,
      new VendoError("validation", input.blocking.join("; "), { appId: input.appId }),
      undefined,
    );
  };
};

const createEditDoor = (
  deps: Pick<AppsRuntimeContext,
    "config" | "requireOwned" | "assembleEdit" | "failedEdit" | "takeEditVersion">,
): AppsRuntime["edit"] => {
  const { config, requireOwned, assembleEdit, failedEdit, takeEditVersion } = deps;
  return async (appId, instruction, ctx) => {
    // Permission before capability (§9.4): a viewer must hear "you can't
    // change the team's copy" — the sentence the fork offer renders from —
    // whether or not this deployment happens to have a model wired.
    const previous = await requireOwned(appId, ctx);
    if (config.model === undefined) {
      throw new VendoError("not-implemented", "generation requires a model");
    }
    // A `.vendo` screen edit goes to the ONE builder: the assembler opens this
    // app's own document, rewrites it and saves it. The save lands through
    // `authored` — the real store write, the real checks floor, the real paint
    // — so the row it leaves behind IS the edit, and this door's only remaining
    // job is to report it.
    const edited = await assembleEdit(appId, instruction, ctx);
    if (edited.kind === "failed") {
      // Nothing was written: the previous app keeps serving out of its own row,
      // which is why this needs no flagged version and no pointer.
      return failedEdit(
        previous,
        instruction,
        edited.issues.length === 0 ? ["edit failed validation"] : edited.issues,
      );
    }
    let app = edited.kind === "assembled" ? edited.app : previous;
    let automation: EditResult["automation"] | undefined;
    let graduated: boolean | undefined;
    const issues: string[] = [];
    // ── The escalation ladder, from an app that already exists ──────────────
    // An edit the assembler cannot make out of components used to reach for a
    // persistent machine. That lane is gone: a bundle app resells through the
    // build door's consent, and a screen edit that needs more than components
    // is an honest refusal rather than a machine spent without a yes.
    if (edited.kind === "escalate") {
      return failedEdit(previous, instruction, [edited.why], false);
    }
    // `authored` appended this edit's own version under the person's words
    // (see `editIntents`), so the version reported here IS that row — read
    // back rather than re-stamped, because a second clock read tells the
    // caller a millisecond history does not hold. Nothing else is written.
    const version: VersionEntry = takeEditVersion(appId, instruction) ?? {
      at: new Date().toISOString(),
      intent: instruction,
      rung: rungFor(app),
    };
    return ({
      app,
      version,
      ...(issues.length === 0 ? {} : { issues }),
      ...(automation === undefined ? {} : { automation }),
      ...(graduated === undefined ? {} : { graduated }),
    });
  };
};

/** The write slice of `AppsRuntime`. */
export const createWriteSurface = (
  deps: Pick<AppsRuntimeContext,
    "config" | "engine" | "caller" | "history" | "holds" | "buildingNow" | "requireOwned"
    | "updateAppDocument" | "assembleEdit" | "failedEdit" | "takeEditVersion"
    | "generationToolContext" | "pruneHistory"
    | "reportLifecycle" | "reportDocumentEdit" | "discardVersion"
    | "editIntents" | "editVersions" | "editRefusals">,
): Pick<AppsRuntime,
  "authoredScreen" | "refusedScreen" | "commitSource" | "edit" | "remember" | "schedule"> => {
  const { config, engine, requireOwned, updateAppDocument } = deps;
  const saveAuthoredDocument = createAuthoredSaver(deps);
  return {
    authoredScreen: createAuthoredScreenDoor({ ...deps, saveAuthoredDocument }),
    refusedScreen: createRefusedScreenDoor(deps),
    edit: createEditDoor(deps),
    async commitSource(input, ctx) {
      // §9.7 — the app's ADDRESS comes from its OWNER, and the row's subject is
      // the authoritative answer (§9.5: a promoted app's row subject IS the org
      // id, verbatim). Read here, never remembered: permission cannot choose an
      // address, because an org app's editor can usually write their own `/user`
      // mount too.
      const subject = (await engine.get(APPS_COLLECTION, input.appId))?.refs?.subject;
      // NO ROW YET IS NOT A FAILURE. A paint is what creates the row (`authored`),
      // so a save the seam declined to paint has none — and the source is already
      // in the workspace files, so the next save that paints persists it. This
      // used to throw `<appId> has no row to hold its source`, which the render
      // seam printed as a loud "source did not reach the store" over a document
      // the writer was already being told about in the floor's own sentences
      // (live 2026-08-06): a misleading error nobody could act on.
      if (subject === undefined) {
        console.info(`[vendo] ${input.appId} has no row yet, so its source waits for the save that paints`);
        return;
      }
      await commitApp(input.appId, input.changed, input.workspace, ctx, {
        requireOwned,
        update: (appId, mutate) => updateAppDocument(appId, mutate),
        ownerOf: async () => subject,
        ...(config.files === undefined ? {} : { blobs: config.files }),
      });
    },

    async remember(input, ctx) {
      // The same `editor` gate every other write to this row passes: appending
      // to an app's memory is changing the app.
      await requireOwned(input.appId, ctx);
      await updateAppDocument(input.appId, (doc) => ({
        ...doc,
        memory: rememberedMemory(doc.memory, input),
        // A REMIX keeps every wish beside the memory, because the two answer
        // different questions. `memory.asks` is a capped working set for the
        // next editor and holds every ask, landed or not; `seed.wishes` is what
        // a re-seed REPLAYS onto the host's new version, so it holds only the
        // asks that reached the screen — a refused attempt is not a change the
        // person has, and one ask refused three times used to leave four entries
        // that every Update then replayed (live 2026-08-18). A wish that fell off
        // a cap would be an edit the person loses the next time the host ships,
        // which is why the list is never trimmed.
        ...(doc.seed === undefined || input.ask === undefined || input.landed !== true
          ? {}
          : { seed: { ...doc.seed, wishes: [...doc.seed.wishes, input.ask] } }),
      }));
    },

    async schedule(appId, cron, ctx) {
      const previous = await requireOwned(appId, ctx);
      const seam = config.automations;
      // Dead ids drop out of `resolve`, so an app whose only scheduled
      // automation was deleted reads exactly like one that never had one.
      const record = seam === undefined
        ? undefined
        : (await seam.resolve(previous.automations ?? [], ctx))
          .find((candidate) => candidate.when.kind === "schedule");
      if (seam === undefined || record === undefined) {
        throw new VendoError(
          "validation",
          `app ${appId} has no schedule to change. A schedule needs something to run, and building that is `
          + "vendo_make's job, not a cron: ask vendo_make, naming this app in `app`, with the schedule and "
          + "the action in one request.",
          { appId },
        );
      }
      // Through the ONE create operation, under the record's own id — same id
      // means REPLACED, so changing when an automation runs is not a second
      // write path onto it. The cron string itself is validated in there, which
      // is the one place that knows the parser.
      await seam.create({
        id: record.id,
        owner: record.owner,
        when: cron,
        task: record.task,
        authoredBy: record.authoredBy,
        ...(record.agent === undefined ? {} : { agent: record.agent }),
        ...(record.timezone === undefined ? {} : { timezone: record.timezone }),
      }, ctx);
      const armed = await seam.enable(record.id, ctx);
      return { appId, cron, enabled: armed.enabled, missing: armed.missing.length };
    },
  };
};
