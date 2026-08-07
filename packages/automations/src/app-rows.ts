/**
 * The `vendo_apps` row, as this engine reads and writes it: the one edit gate
 * every door goes through, the per-kind ref queries the tick and emit fire from,
 * and the pre-rekey cursor migration those queries depend on.
 *
 * Lifted out of `createAutomationsEngine` unchanged.
 */
import {
  DEFAULT_TRIGGER_ID,
  TRIGGER_KIND_REF_PRESENT,
  triggerKindRefKey,
  triggerKindRefs,
  VendoError,
  type AppDocument,
  type RecordStore,
  type RunContext,
  type Trigger,
  type TriggerSource,
  type VendoRecord,
} from "@vendoai/core";
import type { AutomationsEngineContext } from "./engine-context.js";
import { allRecords, appRef, parseAppRow } from "./rows.js";
import { triggerKey, triggerOf } from "./sponsorship.js";
import { validateTrigger } from "./steps.js";
import { APPS, PRE_LIST_TRIGGER_KIND_REF, scheduleSchema, type AppRow } from "./types.js";

export type AppRowsDeps = Pick<AutomationsEngineContext, "config">;

export type AppRowsAccess = Pick<
  AutomationsEngineContext,
  | "appRecord"
  | "editableAppOrNull"
  | "editableApp"
  | "declaredTrigger"
  | "writeApp"
  | "canEdit"
  | "appsFiringOn"
  | "migratePreRekeyCursors"
>;

type AppReader = Pick<
  AutomationsEngineContext,
  "appRecord" | "canEdit" | "editableAppOrNull" | "editableApp" | "declaredTrigger" | "writeApp"
>;

/** One app row: the read, the edit gate over it, and the write. */
const createAppReader = ({ config }: AppRowsDeps): AppReader => {
  const appRecord = async (appId: string): Promise<{ record: VendoRecord; row: AppRow } | null> => {
    const record = await config.store.records(APPS).get(appId);
    return record === null ? null : { record, row: parseAppRow(record) };
  };

  /** §9.3's `can(editor)`, through the config seam. With no seam configured the
   *  deployment has no app-access grants at all, so editor degenerates to
   *  ownership — exactly the wave-1 rule, and the reason this stays optional. */
  const canEdit = async (ctx: RunContext, row: AppRow, appId: string): Promise<boolean> =>
    config.appAccess === undefined
      ? row.subject === ctx.principal.subject
      : await config.appAccess.can(ctx, "editor", { app: appId });

  /** The app, for a caller allowed to CHANGE it — null when it is absent OR the
   *  caller cannot edit it, because those two answer alike everywhere. §8's
   *  editor = edit, and arming makes an editor the person an automation runs as,
   *  so arming, disarming and previewing are theirs too — not the owner's alone.
   *  With no access seam configured this is exactly the ownership check it
   *  replaces. */
  const editableAppOrNull = async (
    appId: string,
    ctx: RunContext,
  ): Promise<{ record: VendoRecord; row: AppRow } | null> => {
    const found = await appRecord(appId);
    return found === null || !await canEdit(ctx, found.row, appId) ? null : found;
  };

  /** The same door, for the callers that must refuse rather than answer empty.
   *  Existence-masking: someone who cannot edit hears "not found", not "no". */
  const editableApp = async (appId: string, ctx: RunContext): Promise<{ record: VendoRecord; row: AppRow }> => {
    const found = await editableAppOrNull(appId, ctx);
    if (found === null) throw new VendoError("not-found", `app not found: ${appId}`);
    return found;
  };

  /** The named trigger of an app, validated — the door every per-trigger
   *  ceremony (enable, dryRun) goes through. A trigger id the document
   *  does not declare is a caller's mistake, not an empty answer. */
  const declaredTrigger = (doc: AppDocument, triggerId: string): Trigger => {
    const declared = triggerOf(doc, triggerId);
    if (declared === undefined) throw new VendoError("validation", `app has no trigger "${triggerId}"`);
    return validateTrigger(declared);
  };

  const writeApp = async (record: VendoRecord, row: AppRow): Promise<void> => {
    // The per-kind trigger refs let the tick/emit fetch apps by trigger kind (the reserved store
    // derives them from columns and ignores caller refs; a generic StoreAdapter honors what we
    // pass here). ONE KEY PER KIND, because an app's triggers are a LIST: a single-valued ref
    // could only name one of them, and the others would never be queried at all.
    await config.store.records(APPS).put({
      id: record.id,
      data: row,
      refs: { subject: row.subject, ...triggerKindRefs(row.doc.triggers) },
    });
  };

  return { appRecord, canEdit, editableAppOrNull, editableApp, declaredTrigger, writeApp };
};

/** The queries the tick and emit fire from, and the cursor migration one of
 *  them depends on. */
const createAppQueries = (
  { config }: AppRowsDeps,
): Pick<AutomationsEngineContext, "migratePreRekeyCursors" | "appsFiringOn"> => {
  /**
   * Move any pre-rekey schedule cursor onto its (app, trigger) key, and return the
   * rows the tick should read for the keys that were missing.
   *
   * The cursor moved from the bare `appId` when an app became a LIST of triggers,
   * and no store rewrites GENERIC row ids, so the old row is invisible everywhere.
   * A cursor the tick cannot find reads as "start the clock now" (so a new
   * schedule does not backfill every window since the epoch) — applied to one that
   * merely moved, that silently restarts a running automation's clock.
   *
   * State is carried VERBATIM: it is the automation's own history, and rewriting
   * it would skip a window or replay one. Only `main` can have a bare-id cursor.
   * The old row is deleted once carried so it can never drag a newer cursor
   * backwards; an unparseable one is left alone and stays the missing cursor it
   * already was. Proven by schedule-cursor.test.ts.
   */
  const migratePreRekeyCursors = async (
    records: RecordStore,
    missing: readonly string[],
  ): Promise<VendoRecord[]> => {
    const preRekeyIds = missing
      .filter((key) => key.endsWith(`:${DEFAULT_TRIGGER_ID}`))
      .map((key) => key.slice(0, -`:${DEFAULT_TRIGGER_ID}`.length));
    if (preRekeyIds.length === 0) return [];
    const carried: VendoRecord[] = [];
    for (const record of await allRecords(records, { ids: preRekeyIds })) {
      const parsed = scheduleSchema.safeParse(record.data);
      if (!parsed.success) continue;
      carried.push(await records.put({
        id: triggerKey(record.id, DEFAULT_TRIGGER_ID),
        data: { ...parsed.data },
        refs: appRef(record.id),
      }));
      await records.delete(record.id);
    }
    return carried;
  };

  /**
   * The app rows that fire on this trigger kind, under EITHER ref spelling.
   *
   * One `trigger_kind: "<kind>"` ref became one key per kind when an app got a
   * LIST of triggers (a ref matches by equality; "which kinds" is a set). The
   * RESERVED store re-derives refs from generated columns, so it migrated itself;
   * a host-supplied adapter stores the refs it is GIVEN (01-core §12) and its
   * pre-list rows still carry the old key. Asking only the new key took every
   * automation armed before the rename dark on BYO storage — no error, no run
   * row, no audit event, the one failure mode an automation may never have.
   *
   * So both are asked and deduped by id. The old-key query ages out without a
   * sweep: `writeApp` re-derives refs, so the first arm, disarm or edit moves the
   * row across. Proven by byo-refs.test.ts.
   */
  const appsFiringOn = async (
    kind: TriggerSource["kind"],
    refs: Record<string, string> = {},
  ): Promise<VendoRecord[]> => {
    const records = config.store.records(APPS);
    // A store that VALIDATES its ref keys refuses the pre-list one — and that is
    // exactly the store which cannot be holding rows written under it, because it
    // DERIVES app refs from the document instead of storing what it was handed.
    // So a validation refusal here honestly means "no pre-list rows". Any other
    // failure still propagates: swallowing a dead connection would turn an outage
    // into "nothing is due", which is the silence this whole function exists to
    // end.
    const preListRows = async (): Promise<VendoRecord[]> => {
      try {
        return await allRecords(records, { refs: { ...refs, [PRE_LIST_TRIGGER_KIND_REF]: kind } });
      } catch (error) {
        if (error instanceof VendoError && error.code === "validation") return [];
        throw error;
      }
    };
    const [current, preList] = await Promise.all([
      allRecords(records, { refs: { ...refs, [triggerKindRefKey(kind)]: TRIGGER_KIND_REF_PRESENT } }),
      preListRows(),
    ]);
    const byId = new Map(current.map((record) => [record.id, record]));
    for (const record of preList) if (!byId.has(record.id)) byId.set(record.id, record);
    return [...byId.values()];
  };

  return { migratePreRekeyCursors, appsFiringOn };
};

export const createAppRows = (deps: AppRowsDeps): AppRowsAccess =>
  ({ ...createAppReader(deps), ...createAppQueries(deps) });
