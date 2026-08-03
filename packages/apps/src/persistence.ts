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
import type { BrainTurn } from "./generation/brain.js";

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

/**
 * The brain's conversation with the app's owner (generation pipeline rebuild,
 * Task 4) rides the app document: the core schema is passthrough, so it travels
 * with the doc on every read and copy without a schema change.
 *
 * It is SERVER-AUTHORITATIVE, on the same footing as `pinDrift` and
 * `buildFailed`: {@link appRecordInput} DROPS whatever `session` a document
 * carries in and writes only the session the caller hands it, so a
 * model-written app, an imported `.vendoapp`, or a host-supplied document can
 * never forge one.
 */
export const SESSION_TURN_CAP = 20;

/** The stored conversation, oldest turn first. Anything unreadable (a
 *  hand-edited row, a forged value) reads as no conversation at all. */
export const sessionOf = (app: AppDocument): BrainTurn[] => {
  const stored = (app as { session?: unknown }).session;
  if (!Array.isArray(stored)) return [];
  return stored.filter((turn): turn is BrainTurn => {
    const candidate = turn as Partial<BrainTurn> | null;
    return typeof candidate === "object" && candidate !== null
      && (candidate.role === "user" || candidate.role === "brain")
      && typeof candidate.text === "string" && typeof candidate.at === "string";
  }).map((turn) => ({ role: turn.role, text: turn.text, at: turn.at }));
};

/** Append this turn's turns and keep the newest {@link SESSION_TURN_CAP} — the
 *  oldest fall off. Dropping old turns loses conversation, never truth: the
 *  app's own text is re-printed fresh for every brain call. */
export const appendSessionTurns = (
  previous: readonly BrainTurn[],
  added: readonly BrainTurn[],
): BrainTurn[] => [...previous, ...added].slice(-SESSION_TURN_CAP);

/** The same document without its conversation. Session hygiene mirrors the
 *  `egressApproved` rule: the transcript belongs to the owner who wrote it, so
 *  it never travels with a copy (share, publish) — {@link appRecordInput}
 *  covers the paths that persist a copy. */
export const withoutSession = <T extends object>(document: T): T => {
  const copy = { ...document } as T & { session?: unknown };
  delete copy.session;
  return copy;
};

/**
 * The app row to write. `session` is the brain conversation to persist beside
 * the document — a caller rewriting a stored app passes `sessionOf(previous)`
 * (or the brain's own next session) to keep it; omitting it clears the
 * conversation, which is also what strips a forged one.
 */
export const appRecordInput = (
  app: AppDocument,
  subject: string,
  enabled = false,
  session?: readonly BrainTurn[],
): AppRecordWrite => {
  const doc = validateDocument(app, app.id) as AppDocument & { session?: BrainTurn[] };
  delete doc.session;
  if (session !== undefined && session.length > 0) doc.session = appendSessionTurns([], session);
  return {
    id: app.id,
    data: { subject, enabled, doc },
    // trigger_kind indexes apps by trigger kind for the automations tick/emit. The reserved
    // vendo_apps store derives the same value from a column; a generic StoreAdapter keeps this.
    refs: { subject, ...(app.trigger === undefined ? {} : { trigger_kind: app.trigger.on.kind }) },
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
    // The mutation sees (and may change) the stored conversation; re-supplying
    // it is what keeps a row update from silently clearing it.
    const input = appRecordInput(next, row.subject, row.enabled, sessionOf(next));
    if (records.atomic === undefined || record.revision === undefined) {
      await records.put(input);
      return next;
    }
    if (await records.atomic.compareAndSwap(input, record.revision) !== null) return next;
  }
  throw new VendoError("conflict", `app ${appId} was concurrently modified`, { appId });
};
