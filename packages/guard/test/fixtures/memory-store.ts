import type {
  BlobStore,
  RecordQuery,
  RecordStore,
  StoreAdapter,
  VendoRecord,
} from "@vendoai/core";

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryRecordStore implements RecordStore {
  readonly #records = new Map<string, VendoRecord>();
  readonly #sequence = new Map<string, number>();
  #nextSequence = 0;

  async get(id: string): Promise<VendoRecord | null> {
    const record = this.#records.get(id);
    return record ? clone(record) : null;
  }

  async put(record: Pick<VendoRecord, "id" | "data" | "refs">): Promise<VendoRecord> {
    const existing = this.#records.get(record.id);
    const now = new Date().toISOString();
    const stored: VendoRecord = {
      id: record.id,
      data: clone(record.data),
      ...(record.refs === undefined ? {} : { refs: clone(record.refs) }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.#records.set(record.id, stored);
    if (!existing) this.#sequence.set(record.id, this.#nextSequence++);
    return clone(stored);
  }

  async delete(id: string): Promise<void> {
    this.#records.delete(id);
    this.#sequence.delete(id);
  }

  async list(query: RecordQuery = {}): Promise<{ records: VendoRecord[]; cursor?: string }> {
    const offset = Math.max(0, Number.parseInt(query.cursor ?? "0", 10) || 0);
    const matching = [...this.#records.values()]
      .filter((record) => !query.ids || query.ids.includes(record.id))
      .filter((record) =>
        Object.entries(query.refs ?? {}).every(([key, value]) => record.refs?.[key] === value),
      )
      .sort((a, b) => {
        const byCreatedAt = b.createdAt.localeCompare(a.createdAt);
        if (byCreatedAt !== 0) return byCreatedAt;
        return (this.#sequence.get(b.id) ?? 0) - (this.#sequence.get(a.id) ?? 0);
      });
    const limit = query.limit ?? matching.length;
    const records = matching.slice(offset, offset + limit).map(clone);
    const nextOffset = offset + records.length;
    return {
      records,
      ...(nextOffset < matching.length ? { cursor: String(nextOffset) } : {}),
    };
  }
}

class MemoryBlobStore implements BlobStore {
  readonly #entries = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(key: string, bytes: Uint8Array, meta?: { contentType?: string }): Promise<void> {
    this.#entries.set(key, {
      bytes: bytes.slice(),
      ...(meta?.contentType === undefined ? {} : { contentType: meta.contentType }),
    });
  }

  async get(key: string): Promise<{ bytes: Uint8Array; contentType?: string } | null> {
    const entry = this.#entries.get(key);
    return entry ? { ...entry, bytes: entry.bytes.slice() } : null;
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async list(prefix = ""): Promise<string[]> {
    return [...this.#entries.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

export class MemoryStore implements StoreAdapter {
  readonly #recordStores = new Map<string, MemoryRecordStore>();
  readonly #blobStores = new Map<string, MemoryBlobStore>();

  records(collection: string): RecordStore {
    let store = this.#recordStores.get(collection);
    if (!store) {
      store = new MemoryRecordStore();
      this.#recordStores.set(collection, store);
    }
    return store;
  }

  blobs(namespace: string): BlobStore {
    let store = this.#blobStores.get(namespace);
    if (!store) {
      store = new MemoryBlobStore();
      this.#blobStores.set(namespace, store);
    }
    return store;
  }

  async ensureSchema(): Promise<void> {}
}

export function createMemoryStore(): MemoryStore {
  return new MemoryStore();
}
