import type {
  BlobStore,
  RecordQuery,
  RecordStore,
  StoreAdapter,
  VendoRecord,
} from "@vendoai/core";

/**
 * In-memory StoreAdapter (01-core §12) for apps-api / gen-scripted, so those
 * suites measure engine overhead rather than PGlite I/O. A trimmed port of
 * @vendoai/apps' testing memory store (not exported via a subpath).
 */

const cloneRecord = (record: VendoRecord): VendoRecord => ({
  ...record,
  data: structuredClone(record.data),
  refs: record.refs === undefined ? undefined : { ...record.refs },
});

const matchesRefs = (
  recordRefs: Record<string, string> | undefined,
  queryRefs: Record<string, string> | undefined,
): boolean =>
  queryRefs === undefined ||
  Object.entries(queryRefs).every(([key, value]) => recordRefs?.[key] === value);

class MemoryRecordStore implements RecordStore {
  constructor(
    private readonly byId: Map<string, VendoRecord>,
    private readonly now: () => string,
  ) {}

  async get(id: string): Promise<VendoRecord | null> {
    const record = this.byId.get(id);
    return record === undefined ? null : cloneRecord(record);
  }

  async put(record: Pick<VendoRecord, "id" | "data" | "refs">): Promise<VendoRecord> {
    const existing = this.byId.get(record.id);
    const now = this.now();
    const stored: VendoRecord = {
      id: record.id,
      data: structuredClone(record.data),
      refs: record.refs === undefined ? undefined : { ...record.refs },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.byId.set(stored.id, stored);
    return cloneRecord(stored);
  }

  async delete(id: string): Promise<void> {
    this.byId.delete(id);
  }

  async list(query: RecordQuery = {}): Promise<{ records: VendoRecord[]; cursor?: string }> {
    const ids = query.ids === undefined ? undefined : new Set(query.ids);
    const matching = [...this.byId.values()]
      .filter((record) => ids === undefined || ids.has(record.id))
      .filter((record) => matchesRefs(record.refs, query.refs))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const offset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 36);
    const end = query.limit === undefined ? matching.length : Math.min(matching.length, offset + query.limit);
    const records = matching.slice(offset, end).map(cloneRecord);
    return end < matching.length ? { records, cursor: end.toString(36) } : { records };
  }
}

class MemoryBlobStore implements BlobStore {
  constructor(private readonly byKey: Map<string, { bytes: Uint8Array; contentType?: string }>) {}

  async put(key: string, bytes: Uint8Array, meta?: { contentType?: string }): Promise<void> {
    this.byKey.set(key, { bytes: bytes.slice(), contentType: meta?.contentType });
  }

  async get(key: string): Promise<{ bytes: Uint8Array; contentType?: string } | null> {
    const blob = this.byKey.get(key);
    return blob === undefined ? null : { bytes: blob.bytes.slice(), contentType: blob.contentType };
  }

  async delete(key: string): Promise<void> {
    this.byKey.delete(key);
  }

  async list(prefix = ""): Promise<string[]> {
    return [...this.byKey.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

class MemoryStoreAdapter implements StoreAdapter {
  private readonly records_ = new Map<string, Map<string, VendoRecord>>();
  private readonly blobs_ = new Map<string, Map<string, { bytes: Uint8Array; contentType?: string }>>();
  private last = 0;

  private readonly now = (): string => {
    this.last = Math.max(Date.now(), this.last + 1);
    return new Date(this.last).toISOString();
  };

  records(collection: string): RecordStore {
    let map = this.records_.get(collection);
    if (map === undefined) {
      map = new Map();
      this.records_.set(collection, map);
    }
    return new MemoryRecordStore(map, this.now);
  }

  blobs(namespace: string): BlobStore {
    let map = this.blobs_.get(namespace);
    if (map === undefined) {
      map = new Map();
      this.blobs_.set(namespace, map);
    }
    return new MemoryBlobStore(map);
  }

  async ensureSchema(): Promise<void> {}
}

export const memoryStore = (): StoreAdapter => new MemoryStoreAdapter();
