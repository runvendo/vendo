import {
  VendoError,
  canonicalJson,
  validateAppDocument,
  type AppDocument,
  type AppId,
  type RecordQuery,
  type RecordStore,
  type VendoRecord,
} from "@vendoai/core";

/** Drain a cursor-paginated listing. A page that repeats its cursor (or drops
 *  it) terminates the loop, so a misbehaving adapter cannot spin forever. */
export const listAllRecords = async (
  records: RecordStore,
  query: Omit<RecordQuery, "cursor"> = {},
): Promise<VendoRecord[]> => {
  const found: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await records.list(cursor === undefined ? query : { ...query, cursor });
    found.push(...page.records);
    if (page.cursor === undefined || page.cursor === cursor) break;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return found;
};

export const validateDocument = (input: unknown, appId: AppId): AppDocument => {
  const result = validateAppDocument(input);
  if (!result.ok || result.app.id !== appId) {
    const reason = result.ok
      ? `document id ${result.app.id} does not match its app row`
      : result.error.message;
    throw new VendoError("validation", `invalid app document for ${appId}`, { appId, reason });
  }
  return structuredClone(result.app);
};

/** The vendo_apps row shape (02-store §2: id, subject, enabled, doc). The
 *  store's reserved records("vendo_apps") routing speaks exactly this — the
 *  document alone is NOT the row; ownership and the automations arm/disarm
 *  bit ride beside it. */
export interface AppRowData {
  subject: string;
  enabled: boolean;
  doc: AppDocument;
}

/** Trigger edits invalidate enable-time capture, cursor, and webhook state.
 *  Canonical comparison — key order must not cause a spurious disarm. */
export const enabledAfterDocumentEdit = (
  previous: AppDocument,
  next: AppDocument,
  enabled: boolean,
): boolean => {
  const canon = (trigger: AppDocument["trigger"]): string =>
    trigger === undefined ? "" : canonicalJson(trigger);
  return canon(previous.trigger) === canon(next.trigger) && enabled;
};

export const rowFromRecord = (record: VendoRecord): AppRowData => {
  const data = record.data as Partial<AppRowData> | null;
  if (
    data === null || typeof data !== "object"
    || typeof data.subject !== "string"
    || typeof data.enabled !== "boolean"
    || data.doc === undefined
  ) {
    throw new VendoError("validation", `invalid app row for ${record.id}`, { appId: record.id });
  }
  return {
    subject: data.subject,
    enabled: data.enabled,
    doc: validateDocument(data.doc, record.id),
  };
};

export const documentFromRecord = (record: VendoRecord): AppDocument =>
  rowFromRecord(record).doc;

export interface AppRecordWrite {
  id: AppId;
  data: AppRowData;
  refs: { subject: string; trigger_kind?: string };
}

export const appRecordInput = (
  app: AppDocument,
  subject: string,
  enabled = false,
): AppRecordWrite => ({
  id: app.id,
  data: { subject, enabled, doc: validateDocument(app, app.id) },
  // trigger_kind indexes apps by trigger kind for the automations tick/emit. The reserved
  // vendo_apps store derives the same value from a column; a generic StoreAdapter keeps this.
  refs: { subject, ...(app.trigger === undefined ? {} : { trigger_kind: app.trigger.on.kind }) },
});

/**
 * Wave 7 — mint the next `machine.envStaleAt` marker, strictly greater than
 * the previous one. Two grant flips in the same millisecond must never mint
 * EQUAL markers: a wake that read the first would clear the second's marker
 * after injecting the older env, losing the newer flip (e.g. a revocation).
 * Marks serialize through the app row's CAS, so bumping past the previous
 * marker is enough.
 */
export const nextEnvStaleAt = (previous?: string): string => {
  const now = Date.now();
  const floor = previous === undefined ? Number.NaN : Date.parse(previous);
  return new Date(Number.isFinite(floor) && floor >= now ? floor + 1 : now).toISOString();
};

/** Bounded read-mutate-CAS on the app row; the store's revision receipt
 *  arbitrates racers (adapters without atomic/revision fall back to put). */
export const updateAppRow = async (
  records: RecordStore,
  appId: AppId,
  mutate: (doc: AppDocument) => AppDocument,
): Promise<AppDocument> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = await records.get(appId);
    if (record === null) throw new VendoError("not-found", `app not found: ${appId}`, { appId });
    const row = rowFromRecord(record);
    const next = mutate(structuredClone(row.doc));
    const input = appRecordInput(next, row.subject, row.enabled);
    if (records.atomic === undefined || record.revision === undefined) {
      await records.put(input);
      return next;
    }
    if (await records.atomic.compareAndSwap(input, record.revision) !== null) return next;
  }
  throw new VendoError("conflict", `app ${appId} was concurrently modified`, { appId });
};
