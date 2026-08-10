import {
  VendoError,
  canonicalJson,
  triggerKindRefs,
  type AppId,
  type RecordQuery,
  type RecordStore,
  type VendoRecord,
} from "@vendoai/core";
import {
  admitAppDocument,
  stripServerAuthoritativeFields,
  validateAppDocument,
  type AdmissionOrigin,
  type AppData,
  type AppDocument,
} from "../../contract/index.js";
import type { EngineOps } from "./engine.js";

/** The app row's drawer. A literal per file was fine while each file bound one
 *  handle; it is an ARGUMENT on every engine verb now, so it has a name. */
export const APPS_COLLECTION = "vendo_apps";

/** Drain a cursor-paginated listing. A page that repeats its cursor (or drops
 *  it) terminates the loop, so a misbehaving adapter cannot spin forever. */
const drain = async (
  list: (query: RecordQuery) => Promise<{ records: VendoRecord[]; cursor?: string }>,
  query: Omit<RecordQuery, "cursor">,
): Promise<VendoRecord[]> => {
  const found: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(cursor === undefined ? query : { ...query, cursor });
    found.push(...page.records);
    if (page.cursor === undefined || page.cursor === cursor) break;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return found;
};

/** Drain an app-data (or host-façade) collection. */
export const listAllRecords = (
  records: RecordStore,
  query: Omit<RecordQuery, "cursor"> = {},
): Promise<VendoRecord[]> => drain((page) => records.list(page), query);

/** Drain one of Vendo's own drawers, by name. */
export const listAllEngineRecords = (
  engine: EngineOps,
  collection: string,
  query: Omit<RecordQuery, "cursor"> = {},
): Promise<VendoRecord[]> => drain((page) => engine.list(collection, page), query);

/** A document coming back OUT of the store. It passed admission on the way in;
 *  this is the read-side integrity check, and it runs admission's inner half
 *  directly because a read has no origin. */
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

/**
 * The one door in, and the only call to {@link admitAppDocument} in the
 * codebase. Every write path reaches the store through {@link appRecordInput}
 * below, which is the only caller, so a document that has not been admitted
 * cannot become a row.
 *
 * `origin` is recorded on the refusal and never changes what is checked.
 */
const admitDocument = (
  input: unknown,
  appId: AppId,
  origin: AdmissionOrigin,
): AppDocument => {
  const admitted = admitAppDocument({ document: input, origin });
  if (!admitted.ok) {
    throw new VendoError("validation", `invalid app document for ${appId}`, {
      appId,
      origin,
      reason: admitted.findings.map((finding) => finding.message).join("; "),
    });
  }
  return structuredClone(admitted.document);
};

/** Trigger edits invalidate enable-time capture, cursor, and webhook state.
 *  Canonical comparison over the whole list — key order (or trigger order)
 *  must not cause a spurious disarm. */
export const enabledAfterDocumentEdit = (
  previous: AppDocument,
  next: AppDocument,
  enabled: boolean,
): boolean =>
  canonicalJson(previous.triggers ?? []) === canonicalJson(next.triggers ?? []) && enabled;

export const rowFromRecord = (record: VendoRecord): AppData => {
  const data = record.data as Partial<AppData> | null;
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
  data: AppData;
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
  enabled: boolean,
  origin: AdmissionOrigin,
): AppRecordWrite => {
  const doc = admitDocument(app, app.id, origin) as AppDocument & { session?: unknown };
  delete doc.session;
  // 06-apps §§8–9 — the venue verdict, the drift report, the data-unavailable
  // claim and CDN furnishing packages are SERVER-AUTHORITATIVE: only code that
  // verified the hash, compared the baseline, or ran the queries may assert
  // them, and none of that is a stored fact. `open.ts` strips them on the way
  // OUT, which kept a forged claim off the wire but left it in the row — three
  // write paths each remembered to strip first and `importApp` did not, so an
  // untrusted `.vendoapp` could seed one. Stripping HERE is the same argument
  // as validating here: the door is what makes "it is in the database" mean
  // one thing, and a reader that forgets is no longer able to be wrong.
  if (doc.tree !== undefined) stripServerAuthoritativeFields(doc.tree);
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

/** Bounded read-mutate-CAS on the app row; the store's revision receipt
 *  arbitrates racers (a row that carries no revision falls back to put). */
export const updateAppRow = async (
  engine: EngineOps,
  appId: AppId,
  mutate: (doc: AppDocument) => AppDocument,
  origin: AdmissionOrigin,
): Promise<AppDocument> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = await engine.get(APPS_COLLECTION, appId);
    if (record === null) throw new VendoError("not-found", `app not found: ${appId}`, { appId });
    const row = rowFromRecord(record);
    const next = mutate(structuredClone(row.doc));
    const input = appRecordInput(next, row.subject, row.enabled, origin);
    if (record.revision === undefined) {
      await engine.put(APPS_COLLECTION, input);
      return next;
    }
    if (await engine.compareAndSwap(APPS_COLLECTION, input, record.revision) !== null) return next;
  }
  throw new VendoError("conflict", `app ${appId} was concurrently modified`, { appId });
};
