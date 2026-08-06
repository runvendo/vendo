import {
  VendoError,
  isoDateTimeSchema,
  type AppDocument,
  type AppId,
  type IsoDateTime,
  type RecordStore,
  type StoreAdapter,
  type VendoRecord,
} from "@vendoai/core";
import { z } from "zod";
import { appRecordInput, documentFromRecord, enabledAfterDocumentEdit, listAllRecords, rowFromRecord, validateDocument } from "./persistence.js";
import type { VersionEntry } from "./runtime.js";

const HISTORY_LIMIT = 50;

const versionEntrySchema = z.object({
  at: isoDateTimeSchema,
  intent: z.string(),
  rung: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
}).passthrough() satisfies z.ZodType<VersionEntry>;

interface HistorySnapshot {
  doc: AppDocument;
  entry: VersionEntry;
  seq: number;
}

/**
 * What a pin-intent row IS, which is what decides whether `pins.rebase` may use it:
 *
 * - `"fork"` — the write that created the pin. The only kind that can vouch for the
 *   pinned component having started as the captured baseline, which is what the
 *   mechanical re-fork reproduces.
 * - `"edit"` — a later modification in the user's own words, so the recorded intent
 *   IS a replayable instruction for the brain.
 * - `"touch"` — a write that changed the pinned component while recording only that
 *   it did ("Saved app.vendo" from a files-first save). Nothing can replay it and
 *   the change lives only in the document it wrote, so a rebase that skipped past
 *   it would silently reset that work to the pristine host component.
 */
export type PinIntentKind = "fork" | "edit" | "touch";

/** Internal replay fuel for 06-apps §8 drift rebases; not a VersionEntry field. */
export interface PinIntentEntry {
  slot: string;
  at: IsoDateTime;
  intent: string;
  /** Absent on rows written before the discriminator existed; `pins.rebase`
   *  treats a row that does not say what it is as unable to vouch for a fork
   *  and as unreplayable. */
  kind?: PinIntentKind;
}

const pinIntentEntrySchema = z.object({
  slot: z.string().min(1),
  at: isoDateTimeSchema,
  intent: z.string(),
  kind: z.union([z.literal("fork"), z.literal("edit"), z.literal("touch")]).optional(),
}).passthrough() satisfies z.ZodType<PinIntentEntry>;

interface StoredPinIntent extends PinIntentEntry {
  versionId: string;
  seq: number;
}

const storedPinIntentSchema = pinIntentEntrySchema.extend({
  versionId: z.string(),
  seq: z.number().int().nonnegative(),
}) satisfies z.ZodType<StoredPinIntent>;

const allRecords = (records: RecordStore): Promise<VendoRecord[]> => listAllRecords(records);

const snapshotFromRecord = (record: VendoRecord, appId: AppId): HistorySnapshot => {
  if (typeof record.data !== "object" || record.data === null || Array.isArray(record.data)) {
    throw new VendoError("validation", `invalid history entry for ${appId}`, { appId });
  }
  const data = record.data as Record<string, unknown>;
  const parsedEntry = versionEntrySchema.safeParse(data.entry);
  if (!parsedEntry.success) {
    throw new VendoError("validation", `invalid history entry for ${appId}`, {
      appId,
      reason: parsedEntry.error.issues[0]?.message ?? "invalid version entry",
    });
  }
  const seq = data.seq === undefined ? 0 : data.seq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    throw new VendoError("validation", `invalid history entry for ${appId}`, {
      appId,
      reason: "invalid history sequence",
    });
  }
  return { doc: validateDocument(data.doc, appId), entry: parsedEntry.data, seq };
};

const storedPinIntentFromRecord = (record: VendoRecord): StoredPinIntent | null => {
  const parsed = storedPinIntentSchema.safeParse(record.data);
  return parsed.success ? parsed.data : null;
};

const sequenceFromRecord = (record: VendoRecord): number => {
  if (typeof record.data !== "object" || record.data === null || Array.isArray(record.data)) return 0;
  const seq = (record.data as Record<string, unknown>).seq;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? seq : 0;
};

export interface AppHistoryAccess {
  /** Returns the appended version's id, so a caller whose write then fails can
   *  `discard` it — an undo point to a state that never became the past is a
   *  loaded gun (`undo` restores the latest snapshot unconditionally). */
  append(
    appId: AppId,
    doc: AppDocument,
    entry: VersionEntry,
    pinSlots?: readonly string[],
    pinKind?: PinIntentKind,
  ): Promise<string>;
  documents(appId: AppId): Promise<AppDocument[]>;
  pinIntents(appId: AppId, slot: string): Promise<PinIntentEntry[]>;
  /** Deletes one version and the pin intents it recorded. */
  discard(appId: AppId, versionId: string): Promise<void>;
  /**
   * Trims the version log to the cap. Called by a caller whose write has
   * LANDED — never by `append` itself: an append whose write is then refused
   * `discard`s its own version, and a prune inside the append would already
   * have deleted the oldest REAL undo point to make room for it. Fifty refused
   * saves would have erased the whole undo history of an app that never changed.
   * The pin-intent trail is not capped (06-apps §8 replays the full trail).
   */
  prune(appId: AppId): Promise<void>;
  clear(appId: AppId): Promise<void>;
  surface(appId: AppId): {
    list(): Promise<VersionEntry[]>;
    undo(): Promise<AppDocument>;
  };
}

/** 06-apps §1 — persisted capped history, kept outside the app artifact. */
export const createAppHistory = (store: StoreAdapter): AppHistoryAccess => {
  const collection = (appId: AppId): RecordStore => store.records(`vendo:app-history:${appId}`);
  const intentCollection = (appId: AppId): RecordStore => store.records(`vendo:app-pin-intents:${appId}`);
  const ordered = async (appId: AppId): Promise<VendoRecord[]> => (await allRecords(collection(appId)))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || sequenceFromRecord(left) - sequenceFromRecord(right)
      || left.id.localeCompare(right.id));
  const deleteVersion = async (appId: AppId, versionId: string): Promise<void> => {
    await collection(appId).delete(versionId);
    const intents = intentCollection(appId);
    for (const record of await allRecords(intents)) {
      if (storedPinIntentFromRecord(record)?.versionId === versionId) await intents.delete(record.id);
    }
  };

  return {
    async append(appId, doc, entry, pinSlots = [], pinKind = "edit") {
      const validated = validateDocument(doc, appId);
      const parsedEntry = versionEntrySchema.parse(entry);
      const records = collection(appId);
      const existing = await allRecords(records);
      const seq = existing.reduce(
        (highest, record) => Math.max(highest, sequenceFromRecord(record)),
        0,
      ) + 1;
      const versionId = `ver_${crypto.randomUUID()}`;
      await records.put({
        id: versionId,
        data: { doc: validated, entry: parsedEntry, seq },
      });
      const intents = intentCollection(appId);
      for (const slot of new Set(pinSlots)) {
        await intents.put({
          id: `pinint_${crypto.randomUUID()}`,
          data: { slot, at: parsedEntry.at, intent: parsedEntry.intent, kind: pinKind, versionId, seq },
          refs: { slot },
        });
      }
      return versionId;
    },
    async documents(appId) {
      const documents: AppDocument[] = [];
      for (const record of await ordered(appId)) {
        try {
          documents.push(snapshotFromRecord(record, appId).doc);
        } catch {
          // Invalid history cannot be restored or surfaced as app data declarations.
        }
      }
      return documents;
    },
    async pinIntents(appId, slot) {
      return (await allRecords(intentCollection(appId)))
        .flatMap((record) => {
          const intent = storedPinIntentFromRecord(record);
          return intent?.slot === slot ? [intent] : [];
        })
        .sort((left, right) => left.seq - right.seq || left.at.localeCompare(right.at))
        .map(({ slot: intentSlot, at, intent, kind }) => ({ slot: intentSlot, at, intent, ...(kind === undefined ? {} : { kind }) }));
    },
    discard: deleteVersion,
    async prune(appId) {
      const records = collection(appId);
      const entries = await ordered(appId);
      for (const expired of entries.slice(0, Math.max(0, entries.length - HISTORY_LIMIT))) {
        await records.delete(expired.id);
      }
    },
    async clear(appId) {
      const records = collection(appId);
      for (const record of await allRecords(records)) await records.delete(record.id);
      const intents = intentCollection(appId);
      for (const record of await allRecords(intents)) await intents.delete(record.id);
    },
    surface(appId) {
      return {
        async list() {
          const appRow = await store.records("vendo_apps").get(appId);
          if (appRow === null) throw new VendoError("not-found", `app not found: ${appId}`);
          documentFromRecord(appRow);
          const entries: VersionEntry[] = [];
          for (const record of (await ordered(appId)).reverse()) {
            try {
              entries.push(snapshotFromRecord(record, appId).entry);
            } catch {
              // One corrupt snapshot must not hide the remaining valid history.
            }
          }
          return entries;
        },
        // history(appId) has no ctx in the frozen contract. The HTTP/wire layer must enforce
        // ownership before exposing this app-id-scoped surface; undo still verifies the app row.
        async undo() {
          const appRow = await store.records("vendo_apps").get(appId);
          if (appRow === null) throw new VendoError("not-found", `app not found: ${appId}`);
          documentFromRecord(appRow);
          const latest = (await ordered(appId)).at(-1);
          if (latest === undefined) throw new VendoError("conflict", "nothing to undo");
          const snapshot = snapshotFromRecord(latest, appId);
          const row = rowFromRecord(appRow);
          // A changed trigger must be re-armed — enable() re-captures and re-mints trigger state.
          const enabled = enabledAfterDocumentEdit(row.doc, snapshot.doc, row.enabled);
          await store.records("vendo_apps").put(
            appRecordInput(snapshot.doc, row.subject, enabled),
          );
          await deleteVersion(appId, latest.id);
          return structuredClone(snapshot.doc);
        },
      };
    },
  };
};
