/**
 * The doors that CHANGE a stored app: the files-first save every author's
 * `app.vendo` lands through, the app's own source commit, the one instruction
 * door, its memory, and its cron.
 *
 * Lifted out of `createApps` unchanged.
 */
import {
  VendoError,
  safeErrorMessage,
  type AppDocument,
  type AppId,
  type RunContext,
  type WireCompileResult,
} from "@vendoai/core";
import { rememberedMemory } from "./app-memory.js";
import { commitApp } from "./app-source.js";
import { NO_MACHINE } from "./build-messages.js";
import { rungFor, touchedPinSlots } from "./edit-journal.js";
import { asPayload } from "./engine.js";
import { escalatedServer } from "./generation/lanes.js";
import { findingLine } from "./build-messages.js";
import { generationDependencies } from "./generation-context.js";
import { compilePlan, type AppPlan } from "@vendoai/core";
import { createProgressiveQueryResolver, stripServerAuthoritativeFields } from "./open.js";
import {
  appRecordInput,
  enabledAfterDocumentEdit,
  rowFromRecord,
} from "./persistence.js";
import { pinComponentName } from "./pins.js";
import type { AppsRuntimeContext } from "./runtime-context.js";
import { asTree } from "./engine.js";
import type { AppsRuntime, EditResult, VersionEntry } from "./types.js";

/** The stored row as `authored` reads it, so the save below can be handed it. */
type AppRow = ReturnType<typeof rowFromRecord>;

/**
 * §1.6 files-first — the app a harness wrote as `app.vendo`, as a document.
 *
 * The tree, the name and the islands are the model's; on an app that ALREADY
 * exists, everything else — trigger, storage, machine, pins, description, the
 * egress grant — is the app's own history and survives untouched. That is
 * exactly `documentFromEdit`'s rule (generation/validation/validate.ts), applied
 * without a model, because saving a file is not a generation.
 *
 * `componentTools` is deliberately NOT stamped: stamping is island admission's
 * job (`prepareIslands`, behind the checking floor), and a manifest invented here
 * would either lie about the sources or carry the PREVIOUS version's islands. Left
 * absent, the renderer derives each island's tool surface from the source it was
 * handed — the pre-stamped rule, and the same posture the mid-turn paint already
 * has (the seam emits raw compiled islands too).
 */
const authoredDocument = (
  appId: AppId,
  compiled: WireCompileResult,
  previous: AppDocument | undefined,
): AppDocument => {
  const name = compiled.name?.trim();
  const document: AppDocument = {
    ...(previous === undefined ? { format: "vendo/app@1" as const } : structuredClone(previous)),
    id: appId,
    // A save mid-build often has no name yet, and the stored name is the app's
    // title in the person's list — so an unnamed document keeps whatever title
    // the app already had rather than losing it.
    name: name === undefined || name === "" ? previous?.name ?? "Untitled app" : name,
    ui: "tree",
    tree: asPayload(structuredClone(compiled.tree)),
  };
  // documentFromEdit's pinned/model split: a PINNED component's source is host
  // source captured on the furnishing trust path, backing a `pins` row that is the
  // app's own history — not a file save's to drop. The compile still wins for a
  // name it does carry (a pinned island IS editable through the wire); a save whose
  // text omits it keeps the stored source, because `pins` carries on naming it and
  // a pin whose source is gone is not a pin (pins.ts demotes it).
  const pinned = new Set((previous?.pins ?? []).map((pin) => pinComponentName(pin.slot)));
  const carried = Object.entries(previous?.components ?? {})
    .filter(([name]) => pinned.has(name) && compiled.components[name] === undefined);
  const components = { ...Object.fromEntries(carried), ...compiled.components };
  if (Object.keys(components).length === 0) {
    delete document.components;
  } else {
    document.components = structuredClone(components);
  }
  delete document.componentTools;
  // The same rule at rest as at serve time (create's own line): a model-forged
  // venue verdict or drift report is never persisted, and a file save can never
  // resurrect a terminal build failure.
  if (document.tree !== undefined) stripServerAuthoritativeFields(document.tree);
  delete document.buildFailed;
  return document;
};

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
    console.error(`[vendo] app not saved (${appId}): the harness wrote it as a file but it did not land — ${reason}`);
    // …and when the save was an EDIT's, the refusal is that edit's answer:
    // the row still holds the pre-edit document, so `assembleEdit` reading
    // it back would report an unchanged app as the change (`editRefusals`).
    const refusedIntent = editIntents.get(appId);
    if (refusedIntent !== undefined) editRefusals.set(appId, { intent: refusedIntent, reason });
    // …and a refused save spends no undo point: the appended version's
    // snapshot predates the concurrent edit the refusal just preserved, and
    // `undo()` would write it straight over that edit (see discardVersion).
    if (appended !== undefined) await discardVersion(appId, appended);
    // …and a discarded version is not history, so it is not this edit's
    // answer either.
    editVersions.delete(appId);
  };
};

const createAuthoredSaver = (
  deps: Pick<AppsRuntimeContext,
    "apps" | "history" | "pruneHistory" | "reportLifecycle" | "reportDocumentEdit"
    | "editIntents" | "editVersions" | "discardVersion" | "editRefusals">,
) => {
  const { apps, history, pruneHistory, reportLifecycle, reportDocumentEdit } = deps;
  const { editIntents, editVersions } = deps;
  const recordRefusedSave = createRefusedSaveRecorder(deps);
  return async (
    input: { appId: AppId; document: AppDocument; previous: AppDocument | undefined; row: AppRow | null },
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
          const current = await apps.get(input.appId);
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
        // The undo point this path had none of: the state the save replaces,
        // appended before the write lands, exactly as persistEdit does it. A
        // re-save that changed nothing is not a version — it would spend one of
        // the 50 capped slots to undo to the state it is already in.
        changed = JSON.stringify(previous) !== JSON.stringify(document);
        if (changed) {
          // The person's own words when THIS runtime asked for the save
          // (`edit`, and the trail `pins.rebase` replays); "Saved app.vendo"
          // for every other author, which is all a bare file save can say.
          const intent = editIntents.get(input.appId);
          const entry: VersionEntry = {
            at: new Date().toISOString(),
            intent: intent ?? "Saved app.vendo",
            rung: rungFor(document),
          };
          // ONE clock read for this save: when the save is an `edit`'s, that
          // door reports this very row (see `editVersions`).
          if (intent !== undefined) editVersions.set(input.appId, entry);
          appended = await history.append(input.appId, previous, entry, touchedPinSlots(previous, document),
          // A "touch" for an authored save, never an "edit": that receipt
          // records THAT the save changed a pinned component and nothing
          // about what it changed. Handing "Saved app.vendo" to a rebase as a
          // replay instruction is how a file-authored remix gets overwritten
          // by the pristine host component under a "rebased" verdict (see
          // pins.rebase) — which is exactly why an edit whose intent IS the
          // person's words records the replayable kind instead.
          intent === undefined ? "touch" : "edit");
        }
        // Asserted a SECOND time, because the append is itself a store round
        // trip and the first check alone leaves it inside the TOCTOU window.
        // Its answer is also the arm bit this write must keep — read after the
        // window, never from the stale baseline row.
        enabled = enabledAfterDocumentEdit(previous, document, await assertCurrent());
      }
      const appRow = appRecordInput(
        document,
        // §9.5 — a promoted app's row subject is the ORG id; the editor check
        // above is what authorized this write, and the row keeps its owner.
        row?.subject ?? ctx.principal.subject,
        enabled,
      );
      await apps.put(appRow);
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

const createAuthoredDoor = (
  deps: Pick<AppsRuntimeContext, "apps" | "caller" | "holds"> & {
    saveAuthoredDocument: ReturnType<typeof createAuthoredSaver>;
  },
): AppsRuntime["authored"] => {
  const { apps, caller, holds, saveAuthoredDocument } = deps;
  return async (input, ctx) => {
    const record = await apps.get(input.appId);
    const row = record === null ? null : rowFromRecord(record);
    // A row that already exists belongs to whoever holds it. `/user/**` is its
    // subject's at EVERY level (core `accessForPath`), so a harness can write
    // `/user/apps/<someone-else's-id>/app.vendo` in its own mount and the
    // workspace lands the file — this is the only place that can refuse to let
    // that rewrite the other person's app. A row that does NOT exist can only
    // have come from this caller's own `/user` mount: a fresh
    // `/orgs/<org>/apps/<id>/` path has no app row to grant on, so `canCommit`
    // refuses it and the file never lands at all.
    const mayWrite = row === null || await holds(input.appId, ctx, "editor", record);
    // And refusing the WRITE is not the whole refusal: `previous` is what these
    // queries resolve against, and `fn:` routes on `app.machine` ALONE (fn.ts)
    // with no ctx — so an inherited machine ref would send this file's `fn:`
    // queries onto SOMEONE ELSE'S sandbox and hand back the answer. A file the
    // caller may not write is painted from the compile alone.
    const previous = row === null || !mayWrite
      ? undefined
      : row.doc;
    const document = authoredDocument(input.appId, input.compiled, previous);
    if (mayWrite) await saveAuthoredDocument({ appId: input.appId, document, previous, row }, ctx);
    // The queries, through the SAME guard-bound caller `open()` resolves with:
    // one guard decision per query, this person's authority, `venue: "app"`. When
    // one FAILED, the seam is told, so the painted view says "Data didn't load"
    // instead of an empty app that looks like real, empty data.
    const queries = createProgressiveQueryResolver(caller, document, ctx);
    queries.update(asTree(document.tree));
    const data = await queries.complete();
    return { data, ...(queries.dataUnavailable() ? { dataUnavailable: true as const } : {}) };
  };
};

/** A SERVED app has no tree, so its edits go to the in-box agent whole. */
const createServedAppEditor = (
  deps: Pick<AppsRuntimeContext,
    "history" | "requireOwned" | "editServerViaBox" | "failedEdit" | "withPinDrift" | "pruneHistory">,
) => {
  const { history, requireOwned, editServerViaBox, failedEdit, withPinDrift, pruneHistory } = deps;
  return async (
    previous: AppDocument,
    appId: AppId,
    instruction: string,
    ctx: RunContext,
  ): Promise<EditResult> => {
    const box = await editServerViaBox(previous, instruction, ctx, { served: true });
    if (!box.ok) {
      return failedEdit(previous, instruction, [
        `the in-box agent could not change the served app: ${box.result.summary}`,
      ]);
    }
    const landed = await requireOwned(appId, ctx);
    const boxVersion: VersionEntry = {
      at: new Date().toISOString(),
      intent: instruction,
      rung: rungFor(landed),
    };
    // The box already landed its own write, so this version is real history
    // the moment it is appended — and the cap applies to it right here.
    await history.append(landed.id, previous, boxVersion, []);
    await pruneHistory(landed.id);
    return withPinDrift({
      app: landed,
      version: { ...boxVersion },
      graduated: true,
      box: {
        ok: box.result.ok,
        summary: box.result.summary,
        ...(box.result.fns === undefined ? {} : { fns: box.result.fns }),
        filesChanged: box.result.filesChanged,
      },
    });
  };
};

const createEditDoor = (
  deps: Pick<AppsRuntimeContext,
    "config" | "lifecycle" | "requireOwned" | "assembleEdit" | "failedEdit" | "withPinDrift"
    | "takeEditVersion" | "generationToolContext" | "runServerWork"> & {
    editServedApp: ReturnType<typeof createServedAppEditor>;
  },
): AppsRuntime["edit"] => {
  const { config, lifecycle, requireOwned, assembleEdit, failedEdit, withPinDrift } = deps;
  const { takeEditVersion, generationToolContext, runServerWork, editServedApp } = deps;
  return async (appId, instruction, ctx) => {
    // Permission before capability (§9.4): a viewer must hear "you can't
    // change the team's copy" — the sentence the fork offer renders from —
    // whether or not this deployment happens to have a model wired.
    const previous = await requireOwned(appId, ctx);
    if (config.model === undefined) {
      throw new VendoError("not-implemented", "generation requires a model");
    }
    // A SERVED app has no tree — its whole surface is the code in its machine —
    // so there is nothing for the brain to edit as text. Every instruction goes
    // to the in-box agent instead, through the same conversation the person is
    // already having with the app.
    if (previous.ui === "http" && previous.machine !== undefined) {
      return await editServedApp(previous, appId, instruction, ctx);
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
    // The assembler could not make this change out of components, so it wrote a
    // plan and asked for the builder — the same §4.5 hand-off a create takes,
    // landing ADDITIVELY on the stored app: an automation on the existing
    // engine, or a box that writes real code and may flip the surface.
    if (edited.kind === "escalate") {
      const planText = await config.escalatedPlan?.(appId, ctx).catch(() => undefined);
      const deps = generationDependencies(config, config.model, await generationToolContext(ctx));
      const compiled = planText === undefined ? undefined : compilePlan(planText, {
        tools: (deps.tools ?? []).map(({ name }) => name),
        components: config.catalog.map(({ name }) => name),
      });
      const base: AppPlan = compiled?.plan
        ?? { name: previous.name, groups: [], queries: [], cannot: [] };
      const planned = { ...base, server: escalatedServer(base, instruction) };
      if (planned.server.kind === "box" && !lifecycle.available()) {
        return failedEdit(previous, instruction, [NO_MACHINE], false);
      }
      try {
        const served = await runServerWork({
          plan: planned,
          ...(planText === undefined ? {} : { planText }),
          document: previous,
          request: instruction,
        }, ctx, deps);
        if (served.failed !== undefined) {
          // The plan REQUIRED this server work and it could not be built, so
          // no edit happened: the stored app is untouched and says why.
          return failedEdit(previous, instruction, served.failed);
        }
        app = served.document;
        automation = served.automation;
        graduated = served.graduated;
        issues.push(...(served.issues ?? []));
        for (const finding of served.findings) {
          console.info(findingLine(finding));
        }
      } catch (error) {
        const reason = safeErrorMessage(error);
        console.warn(`[vendo] the build this edit asked for did not run for ${appId}: ${reason}`);
        return failedEdit(previous, instruction, [reason]);
      }
    }
    // `authored` appended this edit's own undo point under the person's words
    // (see `editIntents`), so the version reported here IS that row — read
    // back rather than re-stamped, because a second clock read tells the
    // caller a millisecond history does not hold. Nothing else is written.
    const version: VersionEntry = takeEditVersion(appId, instruction) ?? {
      at: new Date().toISOString(),
      intent: instruction,
      rung: rungFor(app),
    };
    return withPinDrift({
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
    "config" | "apps" | "caller" | "history" | "holds" | "lifecycle" | "requireOwned"
    | "updateAppDocument" | "assembleEdit" | "failedEdit" | "withPinDrift" | "takeEditVersion"
    | "generationToolContext" | "runServerWork" | "editServerViaBox" | "pruneHistory"
    | "reportLifecycle" | "reportDocumentEdit" | "discardVersion"
    | "editIntents" | "editVersions" | "editRefusals">,
): Pick<AppsRuntime, "authored" | "commitSource" | "edit" | "remember" | "schedule"> => {
  const { config, apps, requireOwned, updateAppDocument } = deps;
  const saveAuthoredDocument = createAuthoredSaver(deps);
  const editServedApp = createServedAppEditor(deps);
  return {
    authored: createAuthoredDoor({ ...deps, saveAuthoredDocument }),
    edit: createEditDoor({ ...deps, editServedApp }),
    async commitSource(input, ctx) {
      await commitApp(input.appId, input.changed, input.workspace, ctx, {
        requireOwned,
        update: (appId, mutate) => updateAppDocument(appId, mutate),
        // §9.7 — the app's ADDRESS comes from its OWNER, and the row's subject is
        // the authoritative answer (§9.5: a promoted app's row subject IS the org
        // id, verbatim). Read here, never remembered: permission cannot choose an
        // address, because an org app's editor can usually write their own `/user`
        // mount too.
        ownerOf: async (appId) => {
          const subject = (await apps.get(appId))?.refs?.subject;
          if (subject === undefined) {
            throw new VendoError("not-found", `${appId} has no row to hold its source`);
          }
          return subject;
        },
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
      }));
    },

    async schedule(appId, cron, ctx) {
      const previous = await requireOwned(appId, ctx);
      const trigger = (previous.triggers ?? []).find((candidate) => candidate.on.kind === "schedule");
      if (trigger === undefined) {
        throw new VendoError(
          "validation",
          `app ${appId} has no schedule to change. Ask for the automation itself first — a schedule needs `
          + "something to run, and that is an edit, not a cron.",
          { appId },
        );
      }
      // Exactly one of cron/every/at may be set (core `triggerSchema`), so
      // choosing a cron REPLACES whichever the app carried. The cron string
      // itself is validated by the arming leg below, which is the one place that
      // knows the parser.
      await updateAppDocument(appId, (document) => ({
        ...document,
        triggers: (document.triggers ?? []).map((candidate) =>
          candidate.id === trigger.id ? { ...candidate, on: { kind: "schedule" as const, cron } } : candidate),
      }));
      if (config.armAutomation === undefined) {
        // No automations engine composed: the cron is stored, and saying it is
        // armed would be a lie.
        return { appId, cron, enabled: false, missing: 0 };
      }
      const armed = await config.armAutomation(appId, trigger.id, ctx);
      return { appId, cron, enabled: armed.enabled, missing: armed.missing.length };
    },
  };
};
