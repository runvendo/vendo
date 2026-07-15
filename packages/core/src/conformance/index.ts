import type { ZodType } from "zod";
import {
  TOOL_NAME_PATTERN,
  VendoError,
  agentRunReportSchema,
  appDocumentSchema,
  appIdSchema,
  approvalRequestSchema,
  authMaterialSchema,
  auditEventSchema,
  canonicalJson,
  descriptorHash,
  guardDecisionSchema,
  isoDateTimeSchema,
  permissionGrantSchema,
  runIdSchema,
  threadIdSchema,
  toolCallSchema,
  toolDescriptorSchema,
  toolOutcomeSchema,
  type ActAs,
  type AgentRunner,
  type AuditEvent,
  type Json,
  type Guard,
  type PermissionGrant,
  type Principal,
  type RecordStore,
  type RunContext,
  type SecretsProvider,
  type StoreAdapter,
  type ToolCall,
  type ToolDescriptor,
  type ToolRegistry,
  type VendoRecord,
} from "../index.js";

/**
 * One executable seam assertion. Cases throw on failure and can be mounted in any
 * test framework, for example: `for (const c of suite.cases) it(c.name, c.run)`.
 */
export interface ConformanceCase {
  name: string;
  run(): Promise<void>;
}

/** A framework-agnostic collection of executable assertions for one core seam. */
export interface ConformanceSuite {
  seam: string;
  cases: ConformanceCase[];
}

/** The serializable result of executing every case in a conformance suite. */
export interface ConformanceReport {
  seam: string;
  passed: number;
  failures: Array<{ name: string; error: string }>;
  ok: boolean;
}

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertParses = <T>(schema: ZodType<T>, value: unknown, message: string): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${message}: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
};

const assertDeepEqual = (actual: unknown, expected: unknown, message: string): void => {
  // undefined is not JSON — map it to a sentinel so a null/undefined mismatch
  // fails with THIS assertion message, not canonicalJson's.
  const canon = (value: unknown): string => (value === undefined ? "undefined" : canonicalJson(value));
  assert(canon(actual) === canon(expected), message);
};

const assertBytesEqual = (actual: Uint8Array, expected: Uint8Array, message: string): void => {
  assert(actual.length === expected.length, `${message}: byte lengths differ`);
  for (let index = 0; index < actual.length; index += 1) {
    assert(actual[index] === expected[index], `${message}: byte ${index} differs`);
  }
};

/** Executes all cases without stopping at the first failure. */
export async function runConformance(suite: ConformanceSuite): Promise<ConformanceReport> {
  const failures: ConformanceReport["failures"] = [];
  let passed = 0;
  for (const conformanceCase of suite.cases) {
    try {
      await conformanceCase.run();
      passed += 1;
    } catch (error) {
      failures.push({
        name: conformanceCase.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { seam: suite.seam, passed, failures, ok: failures.length === 0 };
}

type AdapterFactoryResult = { adapter: StoreAdapter; close?(): Promise<void> };

const adapterCase = (
  opts: { makeAdapter(): Promise<AdapterFactoryResult> },
  name: string,
  body: (adapter: StoreAdapter) => Promise<void>,
): ConformanceCase => ({
  name,
  async run(): Promise<void> {
    const made = await opts.makeAdapter();
    try {
      await body(made.adapter);
    } finally {
      await made.close?.();
    }
  },
});

const readyAdapterCase = (
  opts: { makeAdapter(): Promise<AdapterFactoryResult> },
  name: string,
  body: (adapter: StoreAdapter) => Promise<void>,
): ConformanceCase => adapterCase(opts, name, async (adapter) => {
  await adapter.ensureSchema();
  await body(adapter);
});

/** Executable StoreAdapter checks from 02-store §4 and 01-core §12. */
export function storeAdapterConformance(opts: {
  makeAdapter(): Promise<AdapterFactoryResult>;
}): ConformanceSuite {
  return {
    seam: "StoreAdapter",
    cases: [
      /** 02-store §4: ensureSchema is the idempotent migration entry point. */
      adapterCase(opts, "02-store §4 — ensureSchema is idempotent", async (adapter) => {
        await adapter.ensureSchema();
        await adapter.ensureSchema();
      }),

      /** 01-core §12: put echoes values and supplies ISO timestamps. */
      readyAdapterCase(opts, "01-core §12 — records.put echoes fields and stamps ISO timestamps", async (adapter) => {
        const input = { id: "put_echo", data: { nested: [1, "two"] }, refs: { owner: "user_1" } };
        const record = await adapter.records("conformance_put").put(input);
        assert(record.id === input.id, "put did not echo the record id");
        assertDeepEqual(record.data, input.data, "put did not echo record data");
        assertDeepEqual(record.refs, input.refs, "put did not echo record refs");
        assertParses(isoDateTimeSchema, record.createdAt, "createdAt is not an ISO-8601 timestamp");
        assertParses(isoDateTimeSchema, record.updatedAt, "updatedAt is not an ISO-8601 timestamp");
      }),

      /** 01-core §12: get round-trips a stored record. */
      readyAdapterCase(opts, "01-core §12 — records.get round-trips a put record", async (adapter) => {
        const records = adapter.records("conformance_get");
        const put = await records.put({ id: "round_trip", data: { ok: true }, refs: { host: "invoice_1" } });
        assertDeepEqual(await records.get("round_trip"), put, "get did not round-trip the stored record");
      }),

      /** 01-core §12: get returns null for an unknown id. */
      readyAdapterCase(opts, "01-core §12 — records.get missing returns null", async (adapter) => {
        assert(await adapter.records("conformance_missing").get("absent") === null, "missing record did not return null");
      }),

      /** 01-core §12: a repeated id updates without rewriting creation time. */
      readyAdapterCase(opts, "01-core §12 — records.put same id updates without timestamp regression", async (adapter) => {
        const records = adapter.records("conformance_update");
        const first = await records.put({ id: "same", data: { version: 1 }, refs: { owner: "one" } });
        const second = await records.put({ id: "same", data: { version: 2 }, refs: { owner: "two" } });
        assertDeepEqual(second.data, { version: 2 }, "update did not replace data");
        assertDeepEqual(second.refs, { owner: "two" }, "update did not replace refs");
        assert(second.createdAt === first.createdAt, "update changed createdAt");
        assert(second.updatedAt >= first.updatedAt, "updatedAt regressed");
        assertDeepEqual(await records.get("same"), second, "updated record was not persisted");
      }),

      /** 01-core §12: delete removes an existing record. */
      readyAdapterCase(opts, "01-core §12 — records.delete makes get return null", async (adapter) => {
        const records = adapter.records("conformance_delete");
        await records.put({ id: "delete_me", data: { present: true } });
        await records.delete("delete_me");
        assert(await records.get("delete_me") === null, "deleted record remained readable");
      }),

      /** 01-core §12: deleting an unknown record resolves. */
      readyAdapterCase(opts, "01-core §12 — records.delete missing resolves", async (adapter) => {
        await adapter.records("conformance_delete_missing").delete("absent");
      }),

      /** 01-core §12: an unfiltered list contains all records put. */
      readyAdapterCase(opts, "01-core §12 — records.list returns everything put", async (adapter) => {
        const records = adapter.records("conformance_list_all");
        for (const id of ["all_a", "all_b", "all_c"]) await records.put({ id, data: { id } });
        const result = await records.list();
        assertDeepEqual(result.records.map((record) => record.id).sort(), ["all_a", "all_b", "all_c"], "list omitted or added records");
      }),

      /** 01-core §12: ids limits list results to the requested ids. */
      readyAdapterCase(opts, "01-core §12 — records.list ids filters exactly", async (adapter) => {
        const records = adapter.records("conformance_list_ids");
        for (const id of ["ids_a", "ids_b", "ids_c"]) await records.put({ id, data: { id } });
        const result = await records.list({ ids: ["ids_a", "ids_c"] });
        assertDeepEqual(result.records.map((record) => record.id).sort(), ["ids_a", "ids_c"], "ids filter returned the wrong records");
      }),

      /** 01-core §12: refs uses exact key/value containment. */
      readyAdapterCase(opts, "01-core §12 — records.list refs filters by exact containment", async (adapter) => {
        const records = adapter.records("conformance_list_refs");
        await records.put({ id: "refs_match", data: {}, refs: { owner: "one", kind: "invoice" } });
        await records.put({ id: "refs_wrong_value", data: {}, refs: { owner: "two", kind: "invoice" } });
        await records.put({ id: "refs_missing_key", data: {}, refs: { owner: "one" } });
        const result = await records.list({ refs: { owner: "one", kind: "invoice" } });
        assertDeepEqual(result.records.map((record) => record.id), ["refs_match"], "refs filter was not exact key/value containment");
      }),

      /** 01-core §12: limit and cursor page a full result set exactly once. */
      readyAdapterCase(opts, "01-core §12 — records.list limit and cursor paginate without loss or duplicates", async (adapter) => {
        const records = adapter.records("conformance_pagination");
        const expected = ["page_a", "page_b", "page_c", "page_d", "page_e"];
        for (const id of expected) await records.put({ id, data: { id } });
        const seen: string[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let pageNumber = 0; pageNumber < expected.length + 1; pageNumber += 1) {
          const page = await records.list({ limit: 2, cursor });
          assert(page.records.length <= 2, "page exceeded its requested limit");
          for (const record of page.records) {
            assert(!seen.includes(record.id), `record ${record.id} appeared on more than one page`);
            seen.push(record.id);
          }
          if (page.cursor === undefined) break;
          assert(!cursors.has(page.cursor), "pagination cursor repeated before completion");
          cursors.add(page.cursor);
          cursor = page.cursor;
        }
        assertDeepEqual([...seen].sort(), [...expected].sort(), "pagination omitted or added records");
      }),

      /** 01-core §12: collection names isolate identical record ids. */
      readyAdapterCase(opts, "01-core §12 — record collections isolate identical ids", async (adapter) => {
        const first = adapter.records("conformance_collection_a");
        const second = adapter.records("conformance_collection_b");
        await first.put({ id: "shared", data: { collection: "a" } });
        await second.put({ id: "shared", data: { collection: "b" } });
        assertDeepEqual((await first.get("shared"))?.data, { collection: "a" }, "first collection collided");
        assertDeepEqual((await second.get("shared"))?.data, { collection: "b" }, "second collection collided");
      }),

      /** 01-core §12: blobs round-trip bytes and content type. */
      readyAdapterCase(opts, "01-core §12 — blobs.put and get round-trip bytes and contentType", async (adapter) => {
        const blobs = adapter.blobs("conformance_blob_round_trip");
        const bytes = new Uint8Array([0, 1, 2, 127, 255]);
        await blobs.put("file.bin", bytes, { contentType: "application/octet-stream" });
        const result = await blobs.get("file.bin");
        assert(result !== null, "stored blob returned null");
        assertBytesEqual(result.bytes, bytes, "blob bytes did not round-trip");
        assert(result.contentType === "application/octet-stream", "blob contentType did not round-trip");
      }),

      /** 01-core §12: get returns null for an unknown blob key. */
      readyAdapterCase(opts, "01-core §12 — blobs.get missing returns null", async (adapter) => {
        assert(await adapter.blobs("conformance_blob_missing").get("absent") === null, "missing blob did not return null");
      }),

      /** 01-core §12: delete removes an existing blob. */
      readyAdapterCase(opts, "01-core §12 — blobs.delete removes a blob", async (adapter) => {
        const blobs = adapter.blobs("conformance_blob_delete");
        await blobs.put("delete.bin", new Uint8Array([1]));
        await blobs.delete("delete.bin");
        assert(await blobs.get("delete.bin") === null, "deleted blob remained readable");
      }),

      /** 01-core §12: blob list filters keys by prefix. */
      readyAdapterCase(opts, "01-core §12 — blobs.list filters by prefix", async (adapter) => {
        const blobs = adapter.blobs("conformance_blob_list");
        await blobs.put("images/a.png", new Uint8Array([1]));
        await blobs.put("images/b.png", new Uint8Array([2]));
        await blobs.put("docs/a.txt", new Uint8Array([3]));
        assertDeepEqual((await blobs.list("images/")).sort(), ["images/a.png", "images/b.png"], "blob prefix list returned the wrong keys");
      }),
    ],
  };
}

/** Executable ToolRegistry checks from 01-core §4. */
export function toolRegistryConformance(opts: {
  makeRegistry(): Promise<ToolRegistry>;
  ctx: RunContext;
  safeCall?: ToolCall;
}): ConformanceSuite {
  const cases: ConformanceCase[] = [
    {
      /** 01-core §4: descriptors are schema-valid, uniquely named, and hashable. */
      name: "01-core §4 — descriptors are valid, uniquely named, and hashable",
      async run(): Promise<void> {
        const registry = await opts.makeRegistry();
        const descriptors = await registry.descriptors();
        const names = new Set<string>();
        for (const descriptor of descriptors) {
          assertParses(toolDescriptorSchema, descriptor, `descriptor ${descriptor.name} is invalid`);
          assert(TOOL_NAME_PATTERN.test(descriptor.name), `descriptor name ${descriptor.name} violates TOOL_NAME_PATTERN`);
          assert(!names.has(descriptor.name), `descriptor name ${descriptor.name} is duplicated`);
          names.add(descriptor.name);
          assert(descriptorHash(descriptor).startsWith("sha256:"), `descriptor ${descriptor.name} hash is not sha256-prefixed`);
        }
      },
    },
  ];
  if (opts.safeCall !== undefined) {
    cases.push({
      /** 01-core §4: executing a supplied safe call returns any valid ToolOutcome. */
      name: "01-core §4 — execute resolves to a schema-valid ToolOutcome",
      async run(): Promise<void> {
        const registry = await opts.makeRegistry();
        assertParses(toolOutcomeSchema, await registry.execute(opts.safeCall as ToolCall, opts.ctx), "execute returned an invalid outcome");
      },
    });
  }
  return { seam: "ToolRegistry", cases };
}

/**
 * Executable Guard checks from 01-core §§4, 6 and 05-guard §2.
 *
 * Known limit: the kit verifies `onApprovalDecision` returns a working
 * unsubscribe, but cannot verify decision events actually fire — that needs the
 * guard block's own approvals API (05 §1), so its delivery semantics are
 * exercised by the guard block's test suite, not this seam kit.
 */
export function guardConformance(opts: {
  makeGuard(): Promise<Guard>;
  ctx: RunContext;
  criticalDescriptor: ToolDescriptor;
  criticalCall: ToolCall;
  readDescriptor: ToolDescriptor;
  readCall: ToolCall;
  sampleAuditEvent: AuditEvent;
}): ConformanceSuite {
  return {
    seam: "Guard",
    cases: [
      {
        /** 01-core §6: check returns a GuardDecision for critical and read calls. */
        name: "01-core §6 — check returns schema-valid decisions",
        async run(): Promise<void> {
          const guard = await opts.makeGuard();
          assertParses(guardDecisionSchema, await guard.check(opts.criticalCall, opts.criticalDescriptor, opts.ctx), "critical decision is invalid");
          assertParses(guardDecisionSchema, await guard.check(opts.readCall, opts.readDescriptor, opts.ctx), "read decision is invalid");
        },
      },
      {
        /** 01-core §4 and 05-guard §2 step 1: critical is an unsuppressible ask. */
        name: "01-core §4; 05-guard §2 step 1 — critical always asks with frozen descriptor and input preview",
        async run(): Promise<void> {
          const guard = await opts.makeGuard();
          const decision = assertParses(
            guardDecisionSchema,
            await guard.check(opts.criticalCall, opts.criticalDescriptor, opts.ctx),
            "critical decision is invalid",
          );
          assert(decision.action === "ask", "critical descriptor did not yield ask");
          assert(decision.decidedBy === "critical", "critical ask was not decidedBy critical");
          assert(decision.approval.inputPreview.trim().length > 0, "critical approval inputPreview is empty");
          assertDeepEqual(decision.approval.descriptor, opts.criticalDescriptor, "approval descriptor was not frozen from the asked descriptor");
        },
      },
      {
        /** 01-core §§6-7: report accepts an audit event and resolves. */
        name: "01-core §§6-7 — report resolves for an AuditEvent",
        async run(): Promise<void> {
          const guard = await opts.makeGuard();
          await guard.report(opts.sampleAuditEvent);
        },
      },
      {
        /** 01-core §6: directions resolves to host steering strings. */
        name: "01-core §6 — directions resolves to an array of strings",
        async run(): Promise<void> {
          const guard = await opts.makeGuard();
          const directions = await guard.directions(opts.ctx);
          assert(Array.isArray(directions), "directions did not return an array");
          assert(directions.every((direction) => typeof direction === "string"), "directions contained a non-string value");
        },
      },
      {
        /** 01-core §6: approval subscriptions return a callable unsubscribe. */
        name: "01-core §6 — onApprovalDecision returns a safe unsubscribe function",
        async run(): Promise<void> {
          const guard = await opts.makeGuard();
          const unsubscribe = guard.onApprovalDecision(() => undefined);
          assert(typeof unsubscribe === "function", "onApprovalDecision did not return a function");
          unsubscribe();
        },
      },
    ],
  };
}

/** Executable SecretsProvider checks from 01-core §13. */
export function secretsProviderConformance(opts: {
  makeProvider(): Promise<SecretsProvider>;
  presentName: string;
  expectedValue?: string;
  absentName: string;
}): ConformanceSuite {
  return {
    seam: "SecretsProvider",
    cases: [
      {
        /** 01-core §13: a present secret resolves to its string value. */
        name: "01-core §13 — get present resolves to a string",
        async run(): Promise<void> {
          const provider = await opts.makeProvider();
          const value = await provider.get(opts.presentName);
          assert(typeof value === "string", "present secret did not resolve to a string");
          if (opts.expectedValue !== undefined) assert(value === opts.expectedValue, "present secret did not match expectedValue");
        },
      },
      {
        /** 01-core §13: an absent secret resolves to undefined. */
        name: "01-core §13 — get absent resolves to undefined",
        async run(): Promise<void> {
          const provider = await opts.makeProvider();
          assert(await provider.get(opts.absentName) === undefined, "absent secret did not resolve to undefined");
        },
      },
    ],
  };
}

/** Executable ActAs checks from 01-core §13. */
export function actAsConformance(opts: {
  actAs: ActAs;
  principal: Principal;
  grant: PermissionGrant;
}): ConformanceSuite {
  return {
    seam: "ActAs",
    cases: [{
      /** 01-core §13: ActAs may return null or string-valued auth headers. */
      name: "01-core §13 — actAs resolves to null or schema-valid AuthMaterial",
      async run(): Promise<void> {
        const material = await opts.actAs(opts.principal, opts.grant);
        if (material === null) return;
        const parsed = assertParses(authMaterialSchema, material, "actAs returned invalid AuthMaterial");
        assert(Object.values(parsed.headers).every((value) => typeof value === "string"), "AuthMaterial headers contained a non-string value");
      },
    }],
  };
}

/** Executable AgentRunner checks from 01-core §13 and 03-agent §§1-2. */
export function agentRunnerConformance(opts: {
  makeRunner(): Promise<AgentRunner>;
  ctx: RunContext;
}): ConformanceSuite {
  return {
    seam: "AgentRunner",
    cases: [{
      /** 01-core §13 and 03-agent §§1-2: a headless run returns a valid report. */
      name: "01-core §13; 03-agent §§1-2 — runner returns a schema-valid report",
      async run(): Promise<void> {
        const echoDescriptor: ToolDescriptor = {
          name: "conformance_echo",
          description: "Echo conformance input",
          inputSchema: { type: "object" },
          risk: "read",
        };
        const tools: ToolRegistry = {
          async descriptors() {
            return [echoDescriptor];
          },
          async execute(call) {
            return { status: "ok", output: call.args };
          },
        };
        const runner = await opts.makeRunner();
        const report = assertParses(agentRunReportSchema, await runner({
          prompt: "Call the conformance_echo tool once with { ping: true }, then stop.",
          tools,
          budget: { maxToolCalls: 3 },
        }, opts.ctx), "runner returned an invalid AgentRunReport");
        assert(report.summary.trim().length > 0, "AgentRunReport summary is empty");
        for (const entry of report.toolCalls) {
          assertParses(toolCallSchema, entry.call, "AgentRunReport contains an invalid tool call");
          assert(["ok", "error", "pending-approval", "blocked", "connect-required"].includes(entry.outcome), "AgentRunReport contains an invalid outcome status");
        }
      },
    }],
  };
}

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
      return {
        data: { subject, messages },
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
 * Test double only: a pure in-memory StoreAdapter reference implementation for
 * unit tests. It is not intended as production persistence.
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
        atomic: {
          async insertIfAbsent(input) {
            if (records.has(input.id)) return null;
            const now = new Date().toISOString();
            sequence += 1;
            const record: VendoRecord & { seq: number } = {
              id: input.id,
              data: jsonCopy(input.data),
              refs: input.refs === undefined ? undefined : { ...input.refs },
              createdAt: now,
              updatedAt: now,
              revision: "1",
              seq: sequence,
            };
            records.set(record.id, record);
            return copyRecord(record);
          },
          async compareAndSwap(input, expectedRevision) {
            const previous = records.get(input.id);
            if (previous === undefined || previous.revision !== expectedRevision) return null;
            const now = new Date().toISOString();
            const record: VendoRecord & { seq: number } = {
              id: input.id,
              data: jsonCopy(input.data),
              refs: input.refs === undefined ? undefined : { ...input.refs },
              createdAt: previous.createdAt,
              updatedAt: previous.updatedAt > now ? previous.updatedAt : now,
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
