/**
 * As-of projection: how the firm's document checklists stood at a past instant.
 *
 * This exists for automation rehearsal. rehearse() replays a schedule's past
 * firings, and pins each firing's window onto any READ tool whose input schema
 * declares string `from`/`to` (`acceptsDateBounds` in
 * packages/automations/src/engine.ts). Without that, every replayed firing
 * queries current data and they all come back identical — a timeline that
 * looks like history but isn't.
 *
 * WHAT IS RECOVERABLE, AND WHAT IS NOT. Cadence timestamps exactly one
 * document transition: the upload (`file.uploadedAt`). So the only fact this
 * module rolls back is whether an upload had happened yet:
 *
 *   uploadedAt > asOf  ->  the document was still 'missing' at that instant
 *   otherwise          ->  left exactly as it stands today
 *
 * Verification and rejection carry no timestamp (see DocumentRequest in
 * ./types), and the seeded activity feed is texture, not an event log — so a
 * document's verified/rejected state is ALWAYS the current one, even in a
 * projected view. Nothing here invents history it cannot source; a projection
 * that guessed at verify dates would make rehearsal read more confident than
 * the data supports, which is precisely what the feature exists not to do.
 */
import { getStore } from "./store"
import type { DocumentRequest } from "./types"

/** The documented bound form: an ISO-8601 calendar date, optionally with a time
 *  and zone (what rehearse() pins via `.toISOString()`). Matched BEFORE `new
 *  Date` because that constructor is far more permissive — `new Date("0")` is a
 *  real instant, not a rejection — and a loosely-accepted junk bound would
 *  project a falsely historical checklist instead of degrading to live. */
const ISO_8601_INSTANT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/** Parse an ISO instant from a query param. Invalid or absent -> undefined
 *  (the caller then reads live data), never a thrown error: a malformed bound
 *  should degrade to "now", not fail the read mid-rehearsal. */
export function parseInstant(value: string | null | undefined): Date | undefined {
  if (value == null) return undefined
  const trimmed = value.trim()
  if (trimmed === "" || !ISO_8601_INSTANT.test(trimmed)) return undefined
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) return undefined
  // Guard the calendar date too: the regex accepts a well-FORMED but
  // non-existent day like "2026-02-30", and `new Date` silently rolls it into a
  // real instant (March 2) — a bound that would then project a falsely
  // historical checklist. Round-trip the Y-M-D literal (always the first 10
  // chars per the regex) through a UTC date and reject if any component moved.
  const [year, month, day] = trimmed.slice(0, 10).split("-").map(Number)
  const calendar = new Date(0)
  calendar.setUTCFullYear(year, month - 1, day)
  if (
    calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day
  ) {
    return undefined
  }
  return parsed
}

/** One document as it stood at `asOf`. Undefined `asOf` returns it untouched. */
export function documentAsOf(doc: DocumentRequest, asOf?: Date): DocumentRequest {
  if (asOf === undefined) return doc
  const uploadedAt = doc.file?.uploadedAt
  if (uploadedAt === undefined) return doc
  const uploaded = new Date(uploadedAt)
  if (Number.isNaN(uploaded.getTime()) || uploaded.getTime() <= asOf.getTime()) return doc
  // The upload hadn't landed yet: the request was outstanding, with no file
  // and no rejection note (a note describes a review that also hadn't happened).
  const { file: _file, note: _note, ...rest } = doc
  return { ...rest, status: "missing" }
}

/** Every document as it stood at `asOf` (identity when `asOf` is undefined). */
export function documentsAsOf(asOf?: Date): DocumentRequest[] {
  const docs = getStore().documents
  return asOf === undefined ? docs : docs.map(doc => documentAsOf(doc, asOf))
}
