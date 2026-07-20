import { VendoError, isoDateTimeSchema, type IsoDateTime } from "@vendoai/core";
import type { Db } from "../db.js";

export function iso(value: unknown): IsoDateTime {
  if (!(typeof value === "string" || value instanceof Date)) {
    throw new Error("Expected database timestamp");
  }
  return new Date(value).toISOString();
}

export function optionalIso(value: unknown): IsoDateTime | undefined {
  return value == null ? undefined : iso(value);
}

export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected database text");
  return value;
}

/** Keyset timestamps compare at millisecond precision. The timestamptz cursor
 *  columns can hold microseconds — the §2 table map is public (direct host
 *  SQL, vendo_state's DEFAULT now()), and caller-supplied ISO timestamps
 *  (audit `at`, run `startedAt`) are z.string().datetime()-validated, which
 *  accepts sub-ms digits — while cursors round-trip through JS Dates (ms).
 *  Comparing at full precision against a truncated cursor silently skips rows
 *  (DESC lists) or repeats them (ASC export), so every keyset predicate and
 *  its ORDER BY route BOTH the column and the cursor parameter through this
 *  same truncated expression. */
export function cursorMs(expr: string): string {
  return `date_trunc('milliseconds', ${expr})`;
}

export function encodeCursor(date: IsoDateTime, id: string): string {
  return Buffer.from(JSON.stringify({ c: date, i: id }), "utf8").toString("base64url");
}

export function decodeCursor(value: string): { c: IsoDateTime; i: string } {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("non-canonical cursor");
    const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" || parsed === null
      || Array.isArray(parsed)
      || Object.keys(parsed).length !== 2
      || !Object.prototype.hasOwnProperty.call(parsed, "c")
      || !Object.prototype.hasOwnProperty.call(parsed, "i")
      || typeof (parsed as { c?: unknown }).c !== "string"
      || typeof (parsed as { i?: unknown }).i !== "string"
    ) throw new Error("invalid cursor");
    const timestamp = isoDateTimeSchema.safeParse((parsed as { c: string }).c);
    if (!timestamp.success) throw new Error("invalid cursor timestamp");
    return { c: timestamp.data, i: (parsed as { i: string }).i };
  } catch {
    throw new VendoError("validation", "malformed cursor");
  }
}

export function pageLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 1) {
    throw new VendoError("validation", "limit must be a positive integer");
  }
  return Math.min(value, 1000);
}

export function jsonParam(value: unknown): string {
  return JSON.stringify(value);
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** app:<appId>:… is the collection/namespace grammar for app-scoped record and
 *  blob stores (01-core §12). The appId segment is colon-free by construction. */
const APP_SCOPE = /^app:([^:]+):/;

/** The owning appId of an app-scoped record collection or blob namespace, or
 *  undefined for non-app-scoped scopes. */
export function appScopeId(scope: string): string | undefined {
  return APP_SCOPE.exec(scope)?.[1];
}

/** 02-store §4 (STORE-1): the fail-closed refusal for app-scoped writes whose
 *  owning app has no `vendo_apps` row — never existed, or its ephemeral
 *  session was swept. */
export function unknownAppError(appId: string): VendoError {
  return new VendoError("not-found", `app ${appId} does not exist (its session may have expired)`);
}

/** Pre-check for non-row-creating verbs (delete, guarded mutations): a clean
 *  error signal, not the no-orphan guarantee. Row-CREATING statements embed
 *  the same condition in the statement itself (`WHERE EXISTS (SELECT 1 FROM
 *  vendo_apps WHERE id = ...)`) so a sweep racing the write can never leave an
 *  orphaned row — the guarantee is structural, not ordering care. */
export async function requireKnownApp(db: Db, appId: string | undefined): Promise<void> {
  if (appId === undefined) return;
  const result = await db.query("SELECT 1 FROM vendo_apps WHERE id = $1", [appId]);
  if (result.rows[0] === undefined) throw unknownAppError(appId);
}
