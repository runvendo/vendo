import type {
  AppDocument,
  AppId,
  BlobStore,
  Json,
  RecordStore,
  StorageDecl,
  StoreAdapter,
} from "@vendoai/core";

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
  clear(app: AppDocument, subject: string, historical?: readonly AppDocument[]): Promise<void>;
}

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
