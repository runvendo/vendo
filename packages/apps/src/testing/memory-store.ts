import type {
  BlobStore,
  RecordQuery,
  RecordStore,
  StoreAdapter,
  VendoRecord,
} from "@vendoai/core";

interface StoredBlob {
  bytes: Uint8Array;
  contentType?: string;
}

const cloneRecord = (record: VendoRecord): VendoRecord => ({
  ...record,
  data: structuredClone(record.data),
  refs: record.refs === undefined ? undefined : { ...record.refs },
});

const encodeCursor = (offset: number): string => `mem:${offset.toString(36)}`;

const decodeCursor = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  const match = /^mem:([0-9a-z]+)$/.exec(cursor);
  if (match?.[1] === undefined) throw new Error("Invalid memory-store cursor");
  return Number.parseInt(match[1], 36);
};

const containsRefs = (
  recordRefs: Record<string, string> | undefined,
  queryRefs: Record<string, string> | undefined,
): boolean => queryRefs === undefined || Object.entries(queryRefs).every(
  ([key, value]) => recordRefs?.[key] === value,
);

class MemoryRecordStore implements RecordStore {
  constructor(
    private readonly recordsById: Map<string, VendoRecord>,
    private readonly timestamp: () => string,
  ) {}

  async get(id: string): Promise<VendoRecord | null> {
    const record = this.recordsById.get(id);
    return record === undefined ? null : cloneRecord(record);
  }

  async put(record: Pick<VendoRecord, "id" | "data" | "refs">): Promise<VendoRecord> {
    const existing = this.recordsById.get(record.id);
    const now = this.timestamp();
    const stored: VendoRecord = {
      id: record.id,
      data: structuredClone(record.data),
      refs: record.refs === undefined ? undefined : { ...record.refs },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.recordsById.set(stored.id, stored);
    return cloneRecord(stored);
  }

  async delete(id: string): Promise<void> {
    this.recordsById.delete(id);
  }

  async list(query: RecordQuery = {}): Promise<{ records: VendoRecord[]; cursor?: string }> {
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 0)) {
      throw new RangeError("Memory-store list limit must be a non-negative integer");
    }

    const ids = query.ids === undefined ? undefined : new Set(query.ids);
    const matching = [...this.recordsById.values()]
      .filter((record) => ids === undefined || ids.has(record.id))
      .filter((record) => containsRefs(record.refs, query.refs))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const offset = decodeCursor(query.cursor);
    const end = query.limit === undefined ? matching.length : Math.min(matching.length, offset + query.limit);
    const records = matching.slice(offset, end).map(cloneRecord);
    return end < matching.length
      ? { records, cursor: encodeCursor(end) }
      : { records };
  }
}

class MemoryBlobStore implements BlobStore {
  constructor(private readonly blobsByKey: Map<string, StoredBlob>) {}

  async put(key: string, bytes: Uint8Array, meta?: { contentType?: string }): Promise<void> {
    this.blobsByKey.set(key, {
      bytes: bytes.slice(),
      contentType: meta?.contentType,
    });
  }

  async get(key: string): Promise<{ bytes: Uint8Array; contentType?: string } | null> {
    const blob = this.blobsByKey.get(key);
    return blob === undefined
      ? null
      : { bytes: blob.bytes.slice(), contentType: blob.contentType };
  }

  async delete(key: string): Promise<void> {
    this.blobsByKey.delete(key);
  }

  async list(prefix = ""): Promise<string[]> {
    return [...this.blobsByKey.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

/** In-memory implementation of the complete 01-core §12 store seam. */
export class MemoryStoreAdapter implements StoreAdapter {
  private readonly recordCollections = new Map<string, Map<string, VendoRecord>>();
  private readonly blobNamespaces = new Map<string, Map<string, StoredBlob>>();
  private lastTimestamp = 0;

  constructor(private readonly fixedTimestamp?: () => string) {}

  private readonly timestamp = (): string => {
    if (this.fixedTimestamp !== undefined) return this.fixedTimestamp();
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return new Date(this.lastTimestamp).toISOString();
  };

  records(collection: string): RecordStore {
    let records = this.recordCollections.get(collection);
    if (records === undefined) {
      records = new Map();
      this.recordCollections.set(collection, records);
    }
    return new MemoryRecordStore(records, this.timestamp);
  }

  blobs(namespace: string): BlobStore {
    let blobs = this.blobNamespaces.get(namespace);
    if (blobs === undefined) {
      blobs = new Map();
      this.blobNamespaces.set(namespace, blobs);
    }
    return new MemoryBlobStore(blobs);
  }

  async ensureSchema(): Promise<void> {}
}

/** Create an isolated in-memory StoreAdapter. */
export const memoryStore = (options: { timestamp?: () => string } = {}): MemoryStoreAdapter =>
  new MemoryStoreAdapter(options.timestamp);
