/**
 * The `vendo_apps` row, as this engine reads and writes it: the one edit gate
 * every door goes through, and the per-kind ref queries the tick and emit fire
 * from.
 *
 * Lifted out of `createAutomationsEngine` unchanged.
 */
import {
  TRIGGER_KIND_REF_PRESENT,
  triggerKindRefKey,
  triggerKindRefs,
  VendoError,
  type AppDocument,
  type RunContext,
  type Trigger,
  type TriggerSource,
  type VendoRecord,
} from "@vendoai/core";
import type { EngineBase } from "./engine-context.js";
import { allRecords, parseAppRow } from "./rows.js";
import { triggerOf } from "./sponsorship.js";
import { validateTrigger } from "./steps.js";
import { APPS, type AppData } from "./types.js";

export type AppRowsDeps = { base: EngineBase };

export interface AppRowsAccess {
  /** The app row and its record, or null when there is none. */
  appRecord(appId: string): Promise<{ record: VendoRecord; row: AppData } | null>;
  /** The app, for a caller allowed to CHANGE it — null when absent OR refused. */
  editableAppOrNull(appId: string, ctx: RunContext): Promise<{ record: VendoRecord; row: AppData } | null>;
  /** The same door, existence-masked, for callers that must refuse. */
  editableApp(appId: string, ctx: RunContext): Promise<{ record: VendoRecord; row: AppData }>;
  /** The named trigger of an app, validated. */
  declaredTrigger(doc: AppDocument, triggerId: string): Trigger;
  /** The app row write that re-derives the per-kind trigger refs. */
  writeApp(record: VendoRecord, row: AppData): Promise<void>;
  /** §9.3's `can(editor)`, through the config seam. */
  canEdit(ctx: RunContext, row: AppData, appId: string): Promise<boolean>;
  /** The app rows that fire on this trigger kind, by its per-kind ref. */
  appsFiringOn(kind: TriggerSource["kind"], refs?: Record<string, string>): Promise<VendoRecord[]>;
}

type AppReader = Pick<
  AppRowsAccess,
  "appRecord" | "canEdit" | "editableAppOrNull" | "editableApp" | "declaredTrigger" | "writeApp"
>;

/** One app row: the read, the edit gate over it, and the write. */
const createAppReader = ({ base: { config } }: AppRowsDeps): AppReader => {
  const appRecord = async (appId: string): Promise<{ record: VendoRecord; row: AppData } | null> => {
    const record = await config.store.records(APPS).get(appId);
    return record === null ? null : { record, row: parseAppRow(record) };
  };

  /** §9.3's `can(editor)`, through the config seam. With no seam configured the
   *  deployment has no app-access grants at all, so editor degenerates to
   *  ownership — exactly the wave-1 rule, and the reason this stays optional. */
  const canEdit = async (ctx: RunContext, row: AppData, appId: string): Promise<boolean> =>
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
  ): Promise<{ record: VendoRecord; row: AppData } | null> => {
    const found = await appRecord(appId);
    return found === null || !await canEdit(ctx, found.row, appId) ? null : found;
  };

  /** The same door, for the callers that must refuse rather than answer empty.
   *  Existence-masking: someone who cannot edit hears "not found", not "no". */
  const editableApp = async (appId: string, ctx: RunContext): Promise<{ record: VendoRecord; row: AppData }> => {
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

  const writeApp = async (record: VendoRecord, row: AppData): Promise<void> => {
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

/** The queries the tick and emit fire from. */
const createAppQueries = (
  { base: { config } }: AppRowsDeps,
): Pick<AppRowsAccess, "appsFiringOn"> => {
  /** The app rows that fire on this trigger kind, by its per-kind ref. */
  const appsFiringOn = async (
    kind: TriggerSource["kind"],
    refs: Record<string, string> = {},
  ): Promise<VendoRecord[]> =>
    await allRecords(config.store.records(APPS), {
      refs: { ...refs, [triggerKindRefKey(kind)]: TRIGGER_KIND_REF_PRESENT },
    });

  return { appsFiringOn };
};

export const createAppRows = (deps: AppRowsDeps): AppRowsAccess =>
  ({ ...createAppReader(deps), ...createAppQueries(deps) });
