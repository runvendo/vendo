import {
  VendoError,
  isoDateTimeSchema,
  type AppDocument,
  type AppId,
  type RecordStore,
  type StoreAdapter,
  type VendoRecord,
} from "@vendoai/core";
import { z } from "zod";
import { appRecordInput, documentFromRecord, validateDocument } from "./persistence.js";
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

const allRecords = async (records: RecordStore): Promise<VendoRecord[]> => {
  const found: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await records.list(cursor === undefined ? {} : { cursor });
    found.push(...page.records);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return found;
};

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

const sequenceFromRecord = (record: VendoRecord): number => {
  if (typeof record.data !== "object" || record.data === null || Array.isArray(record.data)) return 0;
  const seq = (record.data as Record<string, unknown>).seq;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? seq : 0;
};

export interface AppHistoryAccess {
  append(appId: AppId, doc: AppDocument, entry: VersionEntry): Promise<void>;
  documents(appId: AppId): Promise<AppDocument[]>;
  clear(appId: AppId): Promise<void>;
  surface(appId: AppId): {
    list(): Promise<VersionEntry[]>;
    undo(): Promise<AppDocument>;
  };
}

/** 06-apps §1 — persisted capped history, kept outside the app artifact. */
export const createAppHistory = (store: StoreAdapter): AppHistoryAccess => {
  const collection = (appId: AppId): RecordStore => store.records(`vendo:app-history:${appId}`);
  const ordered = async (appId: AppId): Promise<VendoRecord[]> => (await allRecords(collection(appId)))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || sequenceFromRecord(left) - sequenceFromRecord(right)
      || left.id.localeCompare(right.id));

  return {
    async append(appId, doc, entry) {
      const validated = validateDocument(doc, appId);
      const parsedEntry = versionEntrySchema.parse(entry);
      const records = collection(appId);
      const existing = await allRecords(records);
      const seq = existing.reduce(
        (highest, record) => Math.max(highest, sequenceFromRecord(record)),
        0,
      ) + 1;
      await records.put({
        id: `ver_${crypto.randomUUID()}`,
        data: { doc: validated, entry: parsedEntry, seq },
      });
      const entries = await ordered(appId);
      for (const expired of entries.slice(0, Math.max(0, entries.length - HISTORY_LIMIT))) {
        await records.delete(expired.id);
      }
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
    async clear(appId) {
      const records = collection(appId);
      for (const record of await allRecords(records)) await records.delete(record.id);
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
          const subject = appRow.refs?.subject;
          if (subject === undefined) {
            throw new VendoError("validation", `invalid app ownership for ${appId}`, { appId });
          }
          await store.records("vendo_apps").put(appRecordInput(snapshot.doc, subject));
          await collection(appId).delete(latest.id);
          return structuredClone(snapshot.doc);
        },
      };
    },
  };
};
