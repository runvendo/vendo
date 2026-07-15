import { z } from "zod";
import { isoDateTimeSchema, type IsoDateTime, type Json } from "./ids.js";

const requiredJsonValueSchema = z.unknown().refine(
  (value) => value !== undefined,
  { message: "required JSON value is missing" },
) as z.ZodType<{}>;

/** 01-core §12 */
export interface VendoRecord {
  id: string;
  data: Json;
  refs?: Record<string, string>;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** 01-core §12 */
export const vendoRecordSchema = z.object({
  id: z.string(),
  data: requiredJsonValueSchema,
  refs: z.record(z.string()).optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).passthrough() satisfies z.ZodType<VendoRecord>;

/** 01-core §12 */
export interface RecordQuery {
  refs?: Record<string, string>;
  ids?: string[];
  limit?: number;
  cursor?: string;
}

/** 01-core §12 */
export const recordQuerySchema = z.object({
  refs: z.record(z.string()).optional(),
  ids: z.array(z.string()).optional(),
  limit: z.number().optional(),
  cursor: z.string().optional(),
}).passthrough() satisfies z.ZodType<RecordQuery>;

/** 01-core §12 */
export interface RecordStore {
  get(id: string): Promise<VendoRecord | null>;
  put(record: Pick<VendoRecord, "id" | "data" | "refs">): Promise<VendoRecord>;
  /**
   * Atomically replace or delete a record only when its current data and refs
   * still equal `expected`. Returns true for the single successful claimant.
   * Omitted by adapters that cannot provide a database-level compare-and-claim.
   */
  claim?(
    expected: Pick<VendoRecord, "id" | "data" | "refs">,
    replacement?: Pick<VendoRecord, "data" | "refs">,
  ): Promise<boolean>;
  delete(id: string): Promise<void>;
  list(query?: RecordQuery): Promise<{ records: VendoRecord[]; cursor?: string }>;
}

/** 01-core §12 */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, meta?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType?: string } | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

/** 01-core §12 */
export interface StoreAdapter {
  records(collection: string): RecordStore;
  blobs(namespace: string): BlobStore;
  ensureSchema(): Promise<void>;
}
