import {
  VendoError,
  canonicalJson,
  triggerKindRefs,
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
 *  Canonical comparison over the whole list — key order (or trigger order)
 *  must not cause a spurious disarm. */
export const enabledAfterDocumentEdit = (
  previous: AppDocument,
  next: AppDocument,
  enabled: boolean,
): boolean =>
  canonicalJson(previous.triggers ?? []) === canonicalJson(next.triggers ?? []) && enabled;

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
  refs: { subject: string } & Record<string, string>;
}

/**
 * The same document without its conversation.
 *
 * `session` was the BRAIN's transcript, carried on the app document so "no, the
 * other chart" could resolve across turns. The brain is gone and so is the
 * conversation: the app's own text is the state every editor reads, and an app's
 * MEMORY (`memory`, the one door in `remember`) is what carries intent forward.
 *
 * This survives it as hygiene. Rows written before the brain died still hold a
 * transcript, and a model-written app or an imported `.vendoapp` can still put
 * the key there — so it is stripped off every document that leaves the runtime,
 * and {@link appRecordInput} strips it off every one that enters the store.
 */
export const withoutSession = <T extends object>(document: T): T => {
  const copy = { ...document } as T & { session?: unknown };
  delete copy.session;
  return copy;
};

/** The app row to write. A `session` the document carries in is dropped — see
 *  {@link withoutSession}: the brain's transcript has no writer any more, and a
 *  forged one must never be persisted. */
export const appRecordInput = (
  app: AppDocument,
  subject: string,
  enabled = false,
): AppRecordWrite => {
  const doc = validateDocument(app, app.id) as AppDocument & { session?: unknown };
  delete doc.session;
  return {
    id: app.id,
    data: { subject, enabled, doc },
    // trigger_kind_<kind> indexes apps by trigger kind for the automations tick/emit — one ref
    // key per kind, because an app's triggers are a LIST and may span more than one kind. The
    // reserved vendo_apps store derives the same value from a column; a generic StoreAdapter
    // keeps this.
    refs: { subject, ...triggerKindRefs(app.triggers) },
  };
};

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
