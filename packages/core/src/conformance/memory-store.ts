import type { ZodType } from "zod";
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
  type Json,
  type RecordStore,
  type StoreAdapter,
  type VendoRecord,
} from "../index.js";

/**
 * The reference in-memory StoreAdapter and its reserved-collection projection
 * rules (02-store §2). Re-exported through conformance/index.ts so the
 * `@vendoai/core/conformance` public surface is unchanged; the seam
 * conformance kits live there.
 */

const jsonCopy = <T>(value: T): T => {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? value : JSON.parse(serialized) as T;
};

const copyRecord = (record: VendoRecord & { seq?: number }): VendoRecord => ({
  id: record.id,
  data: jsonCopy(record.data),
  ...(record.refs === undefined ? {} : { refs: { ...record.refs } }),
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  ...(record.revision === undefined ? {} : { revision: record.revision }),
});

type MemoryRecordInput = Pick<VendoRecord, "id" | "data" | "refs">;

const RESERVED_REF_KEYS: Readonly<Record<string, readonly string[]>> = {
  vendo_grants: ["subject", "tool", "app_id"],
  vendo_approvals: ["subject", "status"],
  vendo_audit: ["subject", "kind", "app_id", "tool"],
  vendo_threads: ["subject"],
  vendo_runs: ["app_id", "status"],
  vendo_apps: ["subject", "trigger_kind"],
  vendo_state: ["app_id", "subject"],
};

const invalidReserved = (message: string): never => {
  throw new VendoError("validation", message);
};

const reservedObject = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidReserved(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const parseReserved = <T>(schema: ZodType<T>, value: unknown, label: string): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  return invalidReserved(`${label}: ${parsed.error.issues[0]?.message ?? "invalid value"}`);
};

const optionalReservedString = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return invalidReserved(`${label} must be a string`);
};

const optionalReservedDate = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  return parseReserved(isoDateTimeSchema, value, label);
};

const isJson = (value: unknown, seen = new Set<object>()): boolean => {
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
};

const requireReservedJson = (value: unknown, label: string): Json => {
  if (!isJson(value)) invalidReserved(`${label} must be JSON-serializable`);
  return value;
};

const requireMatchingRecordId = (recordId: string, embeddedId: string, label: string): void => {
  if (recordId !== embeddedId) invalidReserved(`${label} must equal record id`);
};

const derivedRefs = (values: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));

const splitMemoryStateId = (id: string): { appId: string; subject: string } => {
  const colon = id.indexOf(":");
  if (colon === -1) invalidReserved(`vendo_state record id must be "<appId>:<subject>": ${id}`);
  const appId = id.slice(0, colon);
  if (!/^app_[^:]+$/.test(appId)) {
    invalidReserved(`vendo_state record id must start with a colon-free app id ("app_..."): ${id}`);
  }
  const subject = id.slice(colon + 1);
  if (subject === "") invalidReserved(`vendo_state record id must have a non-empty subject after the colon: ${id}`);
  return { appId, subject };
};

interface MemoryProjection {
  data: Json;
  refs?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

const projectMemoryRecord = (
  collection: string,
  input: MemoryRecordInput,
  previous: VendoRecord | undefined,
  now: string,
): MemoryProjection => {
  switch (collection) {
    case "vendo_grants": {
      const grant = parseReserved(permissionGrantSchema, input.data, "permission grant");
      requireMatchingRecordId(input.id, grant.id, "permission grant id");
      // Mirrors the store routing's cross-subject refusal (02-store §2).
      if (previous?.refs?.["subject"] !== undefined && previous.refs["subject"] !== grant.subject) {
        throw new VendoError("conflict", `grant ${input.id} belongs to another subject`);
      }
      return {
        data: grant,
        refs: derivedRefs({ subject: grant.subject, tool: grant.tool, app_id: grant.appId }),
        createdAt: grant.grantedAt,
        updatedAt: grant.revokedAt ?? grant.grantedAt,
      };
    }
    case "vendo_approvals": {
      const value = reservedObject(input.data, "approval data");
      const request = parseReserved(approvalRequestSchema, value["request"], "approval request");
      requireMatchingRecordId(input.id, request.id, "approval request id");
      const statusValue = value["status"];
      const status = statusValue === "pending" || statusValue === "approved" || statusValue === "denied"
        ? statusValue
        : invalidReserved("approval status must be pending, approved, or denied");
      const decidedAt = optionalReservedDate(value["decidedAt"], "approval decidedAt");
      const sessionId = optionalReservedString(value["sessionId"], "approval sessionId");
      const consumedAt = optionalReservedDate(value["consumedAt"], "approval consumedAt");
      return {
        data: {
          request,
          status,
          ...(decidedAt === undefined ? {} : { decidedAt }),
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(consumedAt === undefined ? {} : { consumedAt }),
        },
        refs: { subject: request.ctx.principal.subject, status },
        createdAt: request.createdAt,
        updatedAt: consumedAt ?? decidedAt ?? request.createdAt,
      };
    }
    case "vendo_audit": {
      const event = parseReserved(auditEventSchema, input.data, "audit event");
      requireMatchingRecordId(input.id, event.id, "audit event id");
      // Mirrors the store routing's append-only refusal (02-store §2).
      if (previous !== undefined) {
        throw new VendoError("conflict", `audit event ${input.id} already exists (vendo_audit is append-only)`);
      }
      return {
        data: event,
        refs: derivedRefs({
          subject: event.principal.subject,
          kind: event.kind,
          app_id: event.appId,
          tool: event.tool,
        }),
        createdAt: event.at,
        updatedAt: event.at,
      };
    }
    case "vendo_threads": {
      parseReserved(threadIdSchema, input.id, "thread id");
      const value = reservedObject(input.data, "thread data");
      const subjectValue = value["subject"];
      const subject = typeof subjectValue === "string"
        ? subjectValue
        : invalidReserved("thread subject must be a string");
      const messageValue = value["messages"];
      const messageInputs = Array.isArray(messageValue)
        ? messageValue
        : invalidReserved("thread messages must be an array");
      if (previous?.refs?.["subject"] !== undefined && previous.refs["subject"] !== subject) {
        throw new VendoError("conflict", `thread ${input.id} belongs to another subject`);
      }
      const messages = messageInputs.map((message, index) =>
        requireReservedJson(message, `thread message ${index}`));
      // Mirrors the store routing's parseThreadData: title is an optional
      // string, kept in the projection.
      const title = optionalReservedString(value["title"], "thread title");
      return {
        data: { subject, messages, ...(title === undefined ? {} : { title }) },
        refs: { subject },
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
    }
    case "vendo_runs": {
      parseReserved(runIdSchema, input.id, "run id");
      const value = reservedObject(input.data, "run data");
      const appId = parseReserved(appIdSchema, value["appId"], "run appId");
      const triggerValue = reservedObject(value["trigger"], "run trigger");
      const kindValue = triggerValue["kind"];
      const kind = kindValue === "schedule" || kindValue === "host-event" || kindValue === "external"
        ? kindValue
        : invalidReserved("run trigger kind is invalid");
      const event = optionalReservedString(triggerValue["event"], "run trigger event");
      const statusValue = value["status"];
      const status = statusValue === "running" || statusValue === "ok" || statusValue === "error"
        || statusValue === "stopped" || statusValue === "pending-approval"
        ? statusValue
        : invalidReserved("run status is invalid");
      const record = requireReservedJson(value["record"], "run record");
      const startedAt = parseReserved(isoDateTimeSchema, value["startedAt"], "run startedAt");
      const finishedAt = optionalReservedDate(value["finishedAt"], "run finishedAt");
      return {
        data: {
          appId,
          trigger: { kind, ...(event === undefined ? {} : { event }) },
          status,
          record,
          startedAt,
          ...(finishedAt === undefined ? {} : { finishedAt }),
        },
        refs: { app_id: appId, status },
        createdAt: startedAt,
        updatedAt: finishedAt ?? startedAt,
      };
    }
    case "vendo_apps": {
      const value = reservedObject(input.data, "app data");
      const subjectValue = value["subject"];
      const subject = typeof subjectValue === "string"
        ? subjectValue
        : invalidReserved("app subject must be a string");
      const enabledValue = value["enabled"];
      const enabled = typeof enabledValue === "boolean"
        ? enabledValue
        : invalidReserved("app enabled must be a boolean");
      const doc = parseReserved(appDocumentSchema, value["doc"], "app document");
      requireMatchingRecordId(input.id, doc.id, "app document id");
      // Mirrors the store routing's cross-subject refusal (02-store §2).
      if (previous?.refs?.["subject"] !== undefined && previous.refs["subject"] !== subject) {
        throw new VendoError("conflict", `app ${input.id} belongs to another subject`);
      }
      return {
        data: { subject, enabled, doc },
        refs: derivedRefs({ subject, trigger_kind: doc.trigger?.on.kind }),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
    }
    case "vendo_state": {
      const { appId, subject } = splitMemoryStateId(input.id);
      return {
        data: requireReservedJson(input.data, "state data"),
        refs: { app_id: appId, subject },
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
    }
    default:
      return {
        data: input.data,
        ...(input.refs === undefined ? {} : { refs: input.refs }),
        createdAt: previous?.createdAt ?? now,
        updatedAt: previous !== undefined && previous.updatedAt > now ? previous.updatedAt : now,
      };
  }
};

/**
 * Reference in-memory StoreAdapter: used by unit tests, and as createAgent's
 * no-store default (03-agent §1, kill-list B5). Process-lifetime only — not
 * durable persistence.
 *
 * Double-level behavior (NOT contract — the conformance suite does not assert
 * it): `list()` returns records newest-first by `createdAt`, most recently
 * CREATED first on ties (updates do not reposition a record, matching a
 * Postgres `ORDER BY created_at DESC` with a stable tiebreak). This mirrors
 * the ordering the store block's adapter is being built with, so block unit
 * tests behave like their integration fixtures. Do not depend on ordering
 * across arbitrary StoreAdapters until the contract pins it.
 */
export interface MemoryStoreAdapterOptions {
  /** Deterministic clock for test assertions. */
  timestamp?: () => string;
}

export function memoryStoreAdapter(
  options: MemoryStoreAdapterOptions = {},
): StoreAdapter & { ensureSchema(): Promise<void> } {
  const collections = new Map<string, Map<string, VendoRecord & { seq: number }>>();
  let sequence = 0;
  let lastTimestamp = 0;
  const namespaces = new Map<string, Map<string, { bytes: Uint8Array; contentType?: string }>>();

  const timestamp = (): string => {
    if (options.timestamp !== undefined) return options.timestamp();
    lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
    return new Date(lastTimestamp).toISOString();
  };

  const recordMap = (collection: string): Map<string, VendoRecord & { seq: number }> => {
    let records = collections.get(collection);
    if (records === undefined) {
      records = new Map<string, VendoRecord & { seq: number }>();
      collections.set(collection, records);
    }
    return records;
  };

  const blobMap = (namespace: string): Map<string, { bytes: Uint8Array; contentType?: string }> => {
    let blobs = namespaces.get(namespace);
    if (blobs === undefined) {
      blobs = new Map<string, { bytes: Uint8Array; contentType?: string }>();
      namespaces.set(namespace, blobs);
    }
    return blobs;
  };

  return {
    async ensureSchema(): Promise<void> {},
    records(collection: string): RecordStore {
      const records = recordMap(collection);
      return {
        async get(id) {
          const record = records.get(id);
          return record === undefined ? null : copyRecord(record);
        },
        async put(input) {
          const previous = records.get(input.id);
          const projected = projectMemoryRecord(collection, input, previous, timestamp());
          sequence += 1;
          const record: VendoRecord & { seq: number } = {
            id: input.id,
            data: jsonCopy(projected.data),
            refs: projected.refs === undefined ? undefined : { ...projected.refs },
            createdAt: projected.createdAt,
            updatedAt: projected.updatedAt,
            revision: String(BigInt(previous?.revision ?? "0") + 1n),
            seq: previous?.seq ?? sequence,
          };
          records.set(record.id, record);
          return copyRecord(record);
        },
        async delete(id) {
          // Mirrors the store routing's append-only refusal (02-store §2):
          // audit rows are erased only via the store erase API (02-store §5).
          if (collection === "vendo_audit") {
            throw new VendoError(
              "blocked",
              "vendo_audit is append-only; rows are erased only via the store erase API (02-store §5)",
            );
          }
          if (collection === "vendo_state") splitMemoryStateId(id);
          records.delete(id);
        },
        async list(query = {}) {
          const reservedRefKeys = RESERVED_REF_KEYS[collection];
          if (reservedRefKeys !== undefined && query.refs !== undefined) {
            for (const key of Object.keys(query.refs)) {
              if (!reservedRefKeys.includes(key)) invalidReserved(`Unknown ${collection} ref key: ${key}`);
            }
          }
          const filtered = [...records.values()].filter((record) => {
            if (query.ids !== undefined && !query.ids.includes(record.id)) return false;
            if (query.refs !== undefined && !Object.entries(query.refs).every(
              ([key, value]) => record.refs?.[key] === value,
            )) return false;
            return true;
          }).sort((a, b) => (
            a.createdAt === b.createdAt ? b.seq - a.seq : (a.createdAt < b.createdAt ? 1 : -1)
          ));
          const parsedOffset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
          const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
          const limit = query.limit === undefined ? filtered.length : Math.max(0, Math.trunc(query.limit));
          const end = Math.min(offset + limit, filtered.length);
          return {
            records: filtered.slice(offset, end).map(copyRecord),
            ...(end < filtered.length ? { cursor: String(end) } : {}),
          };
        },
        // Both verbs share put's projection and clock (02-store §2): reserved
        // collections keep their validation/derived refs, and the injected
        // deterministic timestamp is honored.
        atomic: {
          async insertIfAbsent(input) {
            if (records.has(input.id)) return null;
            const projected = projectMemoryRecord(collection, input, undefined, timestamp());
            sequence += 1;
            const record: VendoRecord & { seq: number } = {
              id: input.id,
              data: jsonCopy(projected.data),
              refs: projected.refs === undefined ? undefined : { ...projected.refs },
              createdAt: projected.createdAt,
              updatedAt: projected.updatedAt,
              revision: "1",
              seq: sequence,
            };
            records.set(record.id, record);
            return copyRecord(record);
          },
          async compareAndSwap(input, expectedRevision) {
            const previous = records.get(input.id);
            if (previous === undefined || previous.revision !== expectedRevision) return null;
            const projected = projectMemoryRecord(collection, input, previous, timestamp());
            const record: VendoRecord & { seq: number } = {
              id: input.id,
              data: jsonCopy(projected.data),
              refs: projected.refs === undefined ? undefined : { ...projected.refs },
              createdAt: projected.createdAt,
              updatedAt: projected.updatedAt,
              revision: String(BigInt(previous.revision) + 1n),
              seq: previous.seq,
            };
            records.set(record.id, record);
            return copyRecord(record);
          },
        },
      };
    },
    blobs(namespace: string) {
      const blobs = blobMap(namespace);
      return {
        async put(key, bytes, meta) {
          blobs.set(key, {
            bytes: new Uint8Array(bytes),
            ...(meta?.contentType === undefined ? {} : { contentType: meta.contentType }),
          });
        },
        async get(key) {
          const blob = blobs.get(key);
          return blob === undefined ? null : {
            bytes: new Uint8Array(blob.bytes),
            ...(blob.contentType === undefined ? {} : { contentType: blob.contentType }),
          };
        },
        async delete(key) {
          blobs.delete(key);
        },
        async list(prefix = "") {
          return [...blobs.keys()].filter((key) => key.startsWith(prefix));
        },
      };
    },
  };
}
