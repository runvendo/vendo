import { z } from "zod";

/** 01-core §1 */
export type AppId = string;

/** 01-core §1 */
export type GrantId = string;

/** 01-core §1 */
export type ApprovalId = string;

/** 01-core §1 */
export type RunId = string;

/** 01-core §1 */
export type ThreadId = string;

/** 01-core §1 */
export type IsoDateTime = string;

/** 01-core §1 */
export type Json = unknown;

/** 01-core §1 */
export type JsonSchema = Record<string, unknown>;

/** 01-core §1 */
export const appIdSchema = z.string().regex(/^app_.+$/) satisfies z.ZodType<AppId>;

/** 01-core §1 */
export const grantIdSchema = z.string().regex(/^grt_.+$/) satisfies z.ZodType<GrantId>;

/** 01-core §1 */
export const approvalIdSchema = z.string().regex(/^apr_.+$/) satisfies z.ZodType<ApprovalId>;

/** 01-core §1 */
export const runIdSchema = z.string().regex(/^run_.+$/) satisfies z.ZodType<RunId>;

/** 01-core §1 */
export const threadIdSchema = z.string().regex(/^thr_.+$/) satisfies z.ZodType<ThreadId>;

/** 01-core §1 */
export const isoDateTimeSchema = z.string().datetime() satisfies z.ZodType<IsoDateTime>;

/** 01-core §1 */
export const jsonSchemaSchema = z.record(z.unknown()) satisfies z.ZodType<JsonSchema>;

/**
 * Composite record-key convention for per-subject rows behind `StoreAdapter.records()`
 * (threads: `<subject>:<threadId>`). The subject segment is escaped so the split on
 * the first `:` is unambiguous for any subject (OIDC subs like `urn:...`/`auth0|x`),
 * and the escaping is SQL-mirrorable: replace(replace(col,'%','%25'),':','%3A').
 */
export function encodeKeySegment(value: string): string {
  return value.replaceAll("%", "%25").replaceAll(":", "%3A");
}

/** Inverse of {@link encodeKeySegment}. */
export function decodeKeySegment(value: string): string {
  return value.replaceAll("%3A", ":").replaceAll("%25", "%");
}
