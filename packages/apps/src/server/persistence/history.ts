import {
  VendoError,
  engineAppHistory,
  isoDateTimeSchema,
  type AppId,
  type VendoRecord,
} from "@vendoai/core";
import {
  type AppDocument,
} from "../../contract/index.js";
import { z } from "zod";
import type { EngineOps } from "./engine.js";
import { APPS_COLLECTION, documentFromRecord, listAllEngineRecords, validateDocument } from "./persistence.js";
import type { VersionEntry } from "../runtime/runtime.js";

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
  /** Returns the appended version's id, so a caller whose write then fails can
   *  `discard` it — a version recording a state that never became the past is a
   *  lie in the trail. */
  append(appId: AppId, doc: AppDocument, entry: VersionEntry): Promise<string>;
  documents(appId: AppId): Promise<AppDocument[]>;
  discard(appId: AppId, versionId: string): Promise<void>;
  /**
   * Trims the version log to the cap. Called by a caller whose write has
   * LANDED — never by `append` itself: an append whose write is then refused
   * `discard`s its own version, and a prune inside the append would already
   * have deleted the oldest REAL version to make room for it. Fifty refused
   * saves would have erased the whole recorded history of an app that never
   * changed once.
   */
  prune(appId: AppId): Promise<void>;
  clear(appId: AppId): Promise<void>;
  surface(appId: AppId): {
    list(): Promise<VersionEntry[]>;
  };
}

/** 06-apps §1 — persisted capped history, kept outside the app artifact. */
export const createAppHistory = (engine: EngineOps): AppHistoryAccess => {
  const allRecords = (appId: AppId): Promise<VendoRecord[]> =>
    listAllEngineRecords(engine, engineAppHistory(appId));
  const ordered = async (appId: AppId): Promise<VendoRecord[]> => (await allRecords(appId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || sequenceFromRecord(left) - sequenceFromRecord(right)
      || left.id.localeCompare(right.id));
  const deleteVersion = async (appId: AppId, versionId: string): Promise<void> => {
    await engine.delete(engineAppHistory(appId), versionId);
  };

  return {
    async append(appId, doc, entry) {
      const validated = validateDocument(doc, appId);
      const parsedEntry = versionEntrySchema.parse(entry);
      const existing = await allRecords(appId);
      const seq = existing.reduce(
        (highest, record) => Math.max(highest, sequenceFromRecord(record)),
        0,
      ) + 1;
      const versionId = `ver_${crypto.randomUUID()}`;
      await engine.put(engineAppHistory(appId), {
        id: versionId,
        data: { doc: validated, entry: parsedEntry, seq },
      });
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
    discard: deleteVersion,
    async prune(appId) {
      const entries = await ordered(appId);
      for (const expired of entries.slice(0, Math.max(0, entries.length - HISTORY_LIMIT))) {
        await engine.delete(engineAppHistory(appId), expired.id);
      }
    },
    async clear(appId) {
      for (const record of await allRecords(appId)) {
        await engine.delete(engineAppHistory(appId), record.id);
      }
    },
    surface(appId) {
      return {
        async list() {
          const appRow = await engine.get(APPS_COLLECTION, appId);
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
      };
    },
  };
};
