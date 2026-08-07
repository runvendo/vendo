/**
 * The store rows this engine reads and writes, as plain functions: paging a
 * collection to the end, parsing a row into its type, and the two-line
 * primitives (`clone`, `id`, `message`) every door leans on.
 *
 * Lifted out of engine.ts unchanged.
 */
import { VendoError, type VendoRecord } from "@vendoai/core";
import type { AutomationsConfig, RunRecord, RunStatus } from "./index.js";
import { appRowSchema, runRowDataSchema, type AppRow, type InternalRunRecord } from "./types.js";

/** Every engine-owned generic row belongs to ONE app, and the 02-store §5 erase
 *  cascade collects generic rows by `refs @> {app_id}` — so a row written
 *  without this ref outlives the app forever. That is not only clutter: a
 *  webhook secret is a live signing key, and the delivery ledger has no other
 *  lifecycle at all. */
export const appRef = (appId: string): Record<string, string> => ({ app_id: appId });

export const clone = <T>(value: T): T => globalThis.structuredClone(value);
export const id = (prefix: string): string => `${prefix}${globalThis.crypto.randomUUID()}`;
export const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const allRecords = async (
  records: ReturnType<AutomationsConfig["store"]["records"]>,
  query: { refs?: Record<string, string>; ids?: string[] } = {},
): Promise<VendoRecord[]> => {
  const found: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await records.list({ ...query, ...(cursor === undefined ? {} : { cursor }) });
    found.push(...page.records);
    if (page.cursor === undefined || page.cursor === cursor) break;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return found;
};

export const parseAppRow = (record: VendoRecord): AppRow => {
  const result = appRowSchema.safeParse(record.data);
  if (!result.success) throw new VendoError("validation", `invalid app row ${record.id}: ${result.error.issues[0]?.message ?? "invalid"}`);
  return result.data;
};

/** The run the row carries. The wrapper columns beside it (`appId`, `status`,
 *  `startedAt`) are validated by the same parse and then never read: they are
 *  the store's own projection of the record, and the record is the run. */
export const parseRunRecord = (record: VendoRecord): InternalRunRecord => {
  const result = runRowDataSchema.safeParse(record.data);
  if (!result.success) throw new VendoError("validation", `invalid run row ${record.id}: ${result.error.issues[0]?.message ?? "invalid"}`);
  return result.data.record as unknown as InternalRunRecord;
};

// Callers already validated the row via parseRunRecord; only the internal fields
// need stripping.
export const publicRun = ({ __event: _, __lineage: __, __trigger: ___, ...record }: InternalRunRecord): RunRecord => record;

export const terminalStatus = (status: RunStatus): status is Extract<RunStatus, "ok" | "error" | "stopped"> =>
  status === "ok" || status === "error" || status === "stopped";

export const syncRun = (target: InternalRunRecord, source: InternalRunRecord): void => {
  delete target.finishedAt;
  delete target.summary;
  delete target.error;
  Object.assign(target, clone(source));
};
