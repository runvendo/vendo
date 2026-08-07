import {
  VendoError,
  appDocumentSchema,
  appIdSchema,
  approvalRequestSchema,
  auditEventSchema,
  isoDateTimeSchema,
  permissionGrantSchema,
  runIdSchema,
  threadIdSchema,
  type AppDocument,
  type ApprovalRequest,
  type AuditEvent,
  type Json,
  type PermissionGrant,
} from "@vendoai/core";
import { isGrantPrincipal, type AccessLevel } from "./helpers/app-access.js";
import type { AppRow, ApprovalRow, RunRow, ThreadRow } from "./helpers/types.js";

export interface ApprovalData {
  request: ApprovalRequest;
  status: ApprovalRow["status"];
  decidedAt?: string;
  sessionId?: string;
  consumedAt?: string;
  deniedBy?: ApprovalRow["deniedBy"];
  voidedAt?: string;
}

export type ThreadData = Pick<ThreadRow, "subject" | "messages" | "title">;
export type RunData = Omit<RunRow, "id">;
export type AppData = Pick<AppRow, "subject" | "enabled" | "doc">;

export function invalid(message: string): never {
  throw new VendoError("validation", message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseSchema<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } },
  value: unknown,
  label: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) invalid(`${label}: ${result.error.issues[0]?.message ?? "invalid value"}`);
  return result.data;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid(`${label} must be a string`);
  return value;
}

function optionalDate(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return parseSchema(isoDateTimeSchema, value, label);
}

function isJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    const valid = value.every((entry) => isJson(entry, seen));
    seen.delete(value);
    return valid;
  }
  if (typeof value === "object") {
    if (seen.has(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    seen.add(value);
    const valid = Object.values(value as Record<string, unknown>).every((entry) => isJson(entry, seen));
    seen.delete(value);
    return valid;
  }
  return false;
}

export function requireJson(value: unknown, label: string): Json {
  if (!isJson(value)) invalid(`${label} must be JSON-serializable`);
  return value;
}

export function requireRecordId(id: unknown): string {
  if (typeof id !== "string") invalid("record id must be a string");
  return id;
}

export function requireMatchingId(recordId: string, embeddedId: string, label: string): void {
  if (embeddedId !== recordId) invalid(`${label} must equal record id`);
}

export function parsePermissionGrant(value: unknown): PermissionGrant {
  return parseSchema(permissionGrantSchema, value, "permission grant");
}

export function parseApprovalRequest(value: unknown): ApprovalRequest {
  return parseSchema(approvalRequestSchema, value, "approval request");
}

export function parseAuditEvent(value: unknown): AuditEvent {
  return parseSchema(auditEventSchema, value, "audit event");
}

export function parseAppDocument(value: unknown): AppDocument {
  return parseSchema(appDocumentSchema, value, "app document");
}

export function parseApprovalData(value: unknown, id: string): ApprovalData {
  const input = object(value, "approval data");
  const request = parseApprovalRequest(input["request"]);
  requireMatchingId(id, request.id, "approval request id");
  const status = input["status"];
  if (status !== "pending" && status !== "approved" && status !== "denied") {
    invalid("approval status must be pending, approved, or denied");
  }
  const decidedAt = optionalDate(input["decidedAt"], "approval decidedAt");
  const sessionId = optionalString(input["sessionId"], "approval sessionId");
  const consumedAt = optionalDate(input["consumedAt"], "approval consumedAt");
  const voidedAt = optionalDate(input["voidedAt"], "approval voidedAt");
  const deniedBy = input["deniedBy"];
  if (deniedBy !== undefined && deniedBy !== "human" && deniedBy !== "system") {
    invalid("approval deniedBy must be human or system");
  }
  return {
    request,
    status,
    ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(consumedAt === undefined ? {} : { consumedAt }),
    ...(deniedBy === undefined ? {} : { deniedBy }),
    ...(voidedAt === undefined ? {} : { voidedAt }),
  };
}

export function parseThreadData(value: unknown, id: string): ThreadData {
  parseSchema(threadIdSchema, id, "thread id");
  const input = object(value, "thread data");
  if (typeof input["subject"] !== "string") invalid("thread subject must be a string");
  if (!Array.isArray(input["messages"])) invalid("thread messages must be an array");
  const messages = input["messages"].map((message, index) => requireJson(message, `thread message ${index}`));
  const title = input["title"];
  if (title !== undefined && typeof title !== "string") invalid("thread title must be a string");
  return { subject: input["subject"], messages, ...(title === undefined ? {} : { title }) };
}

/** Contract §7 — an effect receipt: the subject that owns it (erase cascade +
 *  anon adoption both key on it) and the recorded tool outcome. `at` is the
 *  database's own timestamp; a caller-supplied one is ignored. */
export function parseEffectData(value: unknown, id: string): { subject: string; outcome: Json } {
  if (id === "") invalid("effect key must be a non-empty string");
  const input = object(value, "effect data");
  const subject = input["subject"];
  if (typeof subject !== "string" || subject === "") {
    invalid("effect subject must be a non-empty string");
  }
  return { subject, outcome: requireJson(input["outcome"], "effect outcome") };
}

/** Build contract §9.2 — one app-access grant. Re-checks the principal encoding
 *  the `appAccess` door already checked, because a caller can reach the local
 *  engine's row door directly (`records("vendo_app_grants").put()`) without
 *  passing it. Belt and braces on purpose: this is the last place a doctored row
 *  can be stopped from naming a shape `can()` cannot match (and from letting
 *  `team:` smuggle a second slash) — but only for THIS engine. A hosted or BYO
 *  records adapter never runs it, which is why the door checks too. */
export function parseAppGrantData(value: unknown, id: string): {
  appId: string;
  orgId: string;
  principal: string;
  level: AccessLevel;
  createdBy: string;
} {
  if (!/^ag_.+$/.test(id)) invalid(`app grant id must be "ag_<uuid>": ${id}`);
  const input = object(value, "app grant data");
  const appId = parseSchema(appIdSchema, input["appId"], "app grant appId");
  const orgId = input["orgId"];
  if (typeof orgId !== "string" || orgId === "") invalid("app grant orgId must be a non-empty string");
  const principal = input["principal"];
  if (typeof principal !== "string" || !isGrantPrincipal(principal)) {
    invalid(`app grant principal must be "user:<subject>", "team:<orgId>/<teamId>", or "org:<orgId>": ${String(principal)}`);
  }
  const level = input["level"];
  if (level !== "viewer" && level !== "editor" && level !== "owner") {
    invalid("app grant level must be viewer, editor, or owner");
  }
  const createdBy = input["createdBy"];
  if (typeof createdBy !== "string" || createdBy === "") {
    invalid("app grant createdBy must be a non-empty string");
  }
  return { appId, orgId, principal, level, createdBy };
}

export function parseRunData(value: unknown, id: string): RunData {
  parseSchema(runIdSchema, id, "run id");
  const input = object(value, "run data");
  const appId = parseSchema(appIdSchema, input["appId"], "run appId");
  const triggerInput = object(input["trigger"], "run trigger");
  const kind = triggerInput["kind"];
  if (kind !== "schedule" && kind !== "host-event" && kind !== "external") {
    invalid("run trigger kind is invalid");
  }
  const event = optionalString(triggerInput["event"], "run trigger event");
  const trigger: RunRow["trigger"] = { kind, ...(event === undefined ? {} : { event }) };
  const status = input["status"];
  if (status !== "running" && status !== "ok" && status !== "error"
    && status !== "stopped" && status !== "pending-approval") {
    invalid("run status is invalid");
  }
  const record = requireJson(input["record"], "run record");
  const startedAt = parseSchema(isoDateTimeSchema, input["startedAt"], "run startedAt");
  const finishedAt = optionalDate(input["finishedAt"], "run finishedAt");
  return { appId, trigger, status, record, startedAt, ...(finishedAt === undefined ? {} : { finishedAt }) };
}

export function parseAppData(value: unknown, id: string): AppData {
  const input = object(value, "app data");
  if (typeof input["subject"] !== "string") invalid("app subject must be a string");
  if (typeof input["enabled"] !== "boolean") invalid("app enabled must be a boolean");
  const doc = parseAppDocument(input["doc"]);
  requireMatchingId(id, doc.id, "app document id");
  return { subject: input["subject"], enabled: input["enabled"], doc };
}
