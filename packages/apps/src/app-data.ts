import type {
  AppDocument,
  AppId,
  BlobStore,
  Json,
  RecordStore,
  StorageDecl,
  StoreAdapter,
} from "@vendoai/core";
import { VendoError } from "@vendoai/core";

export const APP_RECORD_MAX_BYTES = 256 * 1024;
/** ENG-289 M1 — app-declared file collections accept blobs up to 5 MB each. */
export const APP_BLOB_MAX_BYTES = 5 * 1024 * 1024;

const encoder = new TextEncoder();

export type AppStorage =
  | { kind: "records"; records: RecordStore }
  | { kind: "files"; blobs: BlobStore };

/** 06-apps §6 — resolve an app declaration onto its isolated store collection. */
export const resolveAppStorage = (
  store: StoreAdapter,
  appId: AppId,
  name: string,
  declaration: StorageDecl,
): AppStorage => declaration.kind === "files"
  ? { kind: "files", blobs: store.blobs(`app:${appId}:${name}`) }
  : { kind: "records", records: store.records(`app:${appId}:${name}`) };

const allRecordIds = async (records: RecordStore): Promise<string[]> => {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await records.list(cursor === undefined ? {} : { cursor });
    ids.push(...page.records.map((record) => record.id));
    cursor = page.cursor;
  } while (cursor !== undefined);
  return ids;
};

const clearRecords = async (records: RecordStore): Promise<void> => {
  for (const id of await allRecordIds(records)) await records.delete(id);
};

const clearBlobs = async (blobs: BlobStore): Promise<void> => {
  for (const key of await blobs.list()) await blobs.delete(key);
};

export interface AppDataAccess {
  getState(appId: AppId, subject: string): Promise<Json | null>;
  setState(appId: AppId, subject: string, data: Json): Promise<void>;
  records(app: AppDocument, name: string): RecordStore;
  blobs(app: AppDocument, name: string): BlobStore;
  clear(app: AppDocument, subject: string, historical?: readonly AppDocument[]): Promise<void>;
}

const declaredStorage = (
  app: AppDocument,
  name: string,
  kind: "records" | "files",
): StorageDecl => {
  if (name === "state") throw new VendoError("validation", 'storage collection "state" is reserved');
  const declaration = app.storage !== undefined
    && Object.prototype.hasOwnProperty.call(app.storage, name)
    ? app.storage[name]
    : undefined;
  const actualKind = declaration?.kind ?? "records";
  if (declaration === undefined || actualKind !== kind) {
    throw new VendoError("not-found", `${kind} collection not found: ${name}`);
  }
  return declaration;
};

const validateRecordRefs = (
  declaration: StorageDecl,
  refs: Record<string, string> | undefined,
): void => {
  if (refs === undefined) return;
  if (typeof refs !== "object" || refs === null || Array.isArray(refs)) {
    throw new VendoError("validation", "record refs must be an object");
  }
  const declared = declaration.refs ?? {};
  for (const [key, value] of Object.entries(refs)) {
    if (!Object.prototype.hasOwnProperty.call(declared, key)) {
      throw new VendoError("validation", `undeclared record ref: ${key}`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new VendoError("validation", `record ref ${key} must be a non-empty string`);
    }
  }
};

const recordByteLength = (record: Parameters<RecordStore["put"]>[0]): number => {
  try {
    const serialized = JSON.stringify(record);
    if (serialized === undefined) throw new Error("record is not JSON serializable");
    return encoder.encode(serialized).byteLength;
  } catch {
    throw new VendoError("validation", "record must be valid JSON");
  }
};

/** 06-apps §6 — private app-data API consumed by lifecycle and later execution lanes. */
export const createAppData = (store: StoreAdapter): AppDataAccess => ({
  async getState(appId, subject) {
    const record = await store.records("vendo_state").get(`${appId}:${subject}`);
    return record === null ? null : structuredClone(record.data);
  },
  async setState(appId, subject, data) {
    await store.records("vendo_state").put({
      id: `${appId}:${subject}`,
      data: structuredClone(data),
      refs: { subject, app_id: appId },
    });
  },
  records(app, name) {
    const declaration = declaredStorage(app, name, "records");
    const storage = resolveAppStorage(store, app.id, name, declaration);
    if (storage.kind !== "records") {
      throw new VendoError("not-found", `records collection not found: ${name}`);
    }
    return {
      get: (id) => storage.records.get(id),
      async put(record) {
        validateRecordRefs(declaration, record.refs);
        if (recordByteLength(record) > APP_RECORD_MAX_BYTES) {
          throw new VendoError("validation", "record exceeds 256 KB size limit");
        }
        return storage.records.put(record);
      },
      delete: (id) => storage.records.delete(id),
      list: (query) => storage.records.list(query),
    };
  },
  blobs(app, name) {
    const declaration = declaredStorage(app, name, "files");
    const storage = resolveAppStorage(store, app.id, name, declaration);
    if (storage.kind !== "files") {
      throw new VendoError("not-found", `files collection not found: ${name}`);
    }
    return {
      async put(key, bytes, meta) {
        if (bytes.byteLength > APP_BLOB_MAX_BYTES) {
          throw new VendoError("validation", "blob exceeds 5 MB size limit");
        }
        await storage.blobs.put(key, bytes, meta);
      },
      get: (key) => storage.blobs.get(key),
      delete: (key) => storage.blobs.delete(key),
      list: (prefix) => storage.blobs.list(prefix),
    };
  },
  async clear(app, subject, historical = []) {
    const declarations = new Map<string, StorageDecl>();
    for (const document of [...historical, app]) {
      for (const [name, declaration] of Object.entries(document.storage ?? {})) {
        declarations.set(`${name}:${declaration.kind ?? "records"}`, declaration);
      }
    }
    for (const [key, declaration] of declarations) {
      const name = key.slice(0, key.lastIndexOf(":"));
      const storage = resolveAppStorage(store, app.id, name, declaration);
      if (storage.kind === "records") await clearRecords(storage.records);
      else await clearBlobs(storage.blobs);
    }
    await store.records("vendo_state").delete(`${app.id}:${subject}`);
    await clearBlobs(store.blobs(`app:${app.id}`));
  },
});
