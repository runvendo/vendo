import {
  type AppDataTarget,
  type AppId,
  type BlobStore,
  type RecordStore,
  type StoreAdapter,
  type StoreOps,
  VendoError,
} from "@vendoai/core";
import type {
  AppDocument,
  StorageDecl,
} from "../../contract/index.js";
import { listAllRecords } from "./persistence.js";

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

/** The appData family, wearing the plain `RecordStore` / `BlobStore` face the
 *  guards below already wrap. The owner rides in the target, so the store
 *  stamps it onto every write and scopes every read to it — nothing here may
 *  set `refs.subject`, which the family refuses. */
type AppDataOps = NonNullable<StoreOps["appData"]>;

const appDataRecords = (rows: AppDataOps, target: AppDataTarget): RecordStore => ({
  get: (id) => rows.get(target, id),
  put: (record) => rows.put(target, record),
  delete: (id) => rows.delete(target, id),
  list: (query) => rows.list(target, query),
});

const appDataBlobs = (rows: AppDataOps, target: AppDataTarget): BlobStore => ({
  put: (key, bytes, meta) => rows.putFile(target, key, bytes, meta),
  get: (key) => rows.getFile(target, key),
  delete: (key) => rows.deleteFile(target, key),
  list: (prefix) => rows.listFiles(target, prefix),
});

/** The ONE spelling of "which store backs this collection". `selectStoreOps`
 *  gives a three-way answer — the store's own ops, the local backend over a SQL
 *  handle, or nothing at all for a store with neither. Requiring `ops` would
 *  crash composition at boot for that third store, where today it refuses at
 *  the op that needed one; so a store without an ops surface keeps exactly
 *  today's façade behavior, unowned, and a store with one gets owner stamping.
 *  An ops surface that OMITS the optional appData family reads as the same
 *  answer — it has no app-row door either. No other branch. */
const backingFor = (
  ops: StoreOps | undefined,
  store: StoreAdapter,
  target: AppDataTarget,
  declaration: StorageDecl,
): AppStorage => {
  const rows = ops?.appData;
  if (rows === undefined) return resolveAppStorage(store, target.appId, target.collection, declaration);
  return declaration.kind === "files"
    ? { kind: "files", blobs: appDataBlobs(rows, target) }
    : { kind: "records", records: appDataRecords(rows, target) };
};

const allRecordIds = async (records: RecordStore): Promise<string[]> =>
  (await listAllRecords(records)).map((record) => record.id);

const clearRecords = async (records: RecordStore): Promise<void> => {
  for (const id of await allRecordIds(records)) await records.delete(id);
};

const clearBlobs = async (blobs: BlobStore): Promise<void> => {
  for (const key of await blobs.list()) await blobs.delete(key);
};

export interface AppDataAccess {
  records(app: AppDocument, name: string, owner: string): RecordStore;
  blobs(app: AppDocument, name: string, owner: string): BlobStore;
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
export const createAppData = (
  { ops, store }: { ops: StoreOps | undefined; store: StoreAdapter },
): AppDataAccess => ({
  records(app, name, owner) {
    const declaration = declaredStorage(app, name, "records");
    const storage = backingFor(ops, store, { appId: app.id, collection: name, owner }, declaration);
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
  blobs(app, name, owner) {
    const declaration = declaredStorage(app, name, "files");
    const storage = backingFor(ops, store, { appId: app.id, collection: name, owner }, declaration);
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
      // Owner-scoped through the same backing the doors write: an appData list
      // already sees only this subject's rows, so the sweep empties the
      // caller's drawer and nobody else's.
      const storage = backingFor(ops, store, { appId: app.id, collection: name, owner: subject }, declaration);
      if (storage.kind === "records") await clearRecords(storage.records);
      else await clearBlobs(storage.blobs);
    }
    await clearBlobs(store.blobs(`app:${app.id}`));
  },
});
