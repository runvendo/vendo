import { assert, assertBytesEqual, assertDeepEqual, assertParses } from "./assertions.js";
import {
  TOOL_NAME_PATTERN,
  agentRunReportSchema,
  authMaterialSchema,
  descriptorHash,
  guardDecisionSchema,
  isoDateTimeSchema,
  toolCallSchema,
  toolDescriptorSchema,
  toolOutcomeSchema,
  type ActAs,
  type AgentRunner,
  type AuditEvent,
  type Guard,
  type PermissionGrant,
  type Principal,
  type RunContext,
  type SecretsProvider,
  type StoreAdapter,
  type ToolCall,
  type ToolDescriptor,
  type ToolRegistry,
} from "../index.js";

export { memoryStoreAdapter, type MemoryStoreAdapterOptions } from "./memory-store.js";
export { memoryKnowledgeAdapter, type MemoryKnowledgeAdapterOptions } from "./memory-knowledge.js";
export { knowledgeAdapterConformance, type KnowledgeConformanceOptions } from "./knowledge.js";
export { appAccessConformance, type AppAccessConformanceOptions } from "./app-access.js";
export { storeOpsConformance, type StoreOpsConformanceOptions } from "./store-ops.js";
export { memoryStoreOps } from "./memory-store-ops.js";
export { memoryAppAccess, type MemoryAppAccess } from "./memory-app-access.js";

/**
 * One executable seam assertion. Cases throw on failure and can be mounted in any
 * test framework, for example: `for (const c of suite.cases) it(c.name, c.run)`.
 */
/**
 * What a case answers when the mount does not serve the OPTIONAL member the
 * case covers (`transcripts.appendMessages`, `retention`, a second tenant).
 *
 * RETURNED, never thrown: omitting an optional member is legal, so it is not a
 * failure. It is not a PASS either, and that is the whole point — a case that
 * simply `return`ed on an absent member made "this mount does not serve the op"
 * and "this mount serves the op correctly" the same green line, so an
 * implementation could drop a whole family and never appear to. An omission is
 * counted in its own bucket instead, named and reasoned, so it has to be read.
 */
export interface ConformanceOmission {
  omitted: string;
}

/** Spells {@link ConformanceOmission} at a case's return site. */
export const omitted = (reason: string): ConformanceOmission => ({ omitted: reason });

export interface ConformanceCase {
  name: string;
  /**
   * Why this case does not run yet, and which lane lands it. Set it and the
   * case is carried but never executed — by `runConformance`, and by every
   * mount, which reports it as skipped WITH this reason in the test name.
   *
   * It exists so that an op the contract declares and nothing yet serves is
   * VISIBLE. The alternative every time has been to leave the case out until
   * its implementation arrives, and a case nobody can see is how a feature
   * ships dead four times over: the suite is green, the op is in the types,
   * and the first person to find out is a caller in production. A named
   * pending case is a standing line in the test output that says the contract
   * is ahead of the code and who owes the difference.
   *
   * The body is a real one, not a placeholder: landing the capability means
   * deleting this one field.
   */
  pending?: string;
  /** Throws on failure. Resolves to a {@link ConformanceOmission} when the
      mount does not serve the optional member this case covers, and to nothing
      when it ran. */
  run(): Promise<void | ConformanceOmission>;
}

/** A framework-agnostic collection of executable assertions for one core seam. */
export interface ConformanceSuite {
  seam: string;
  cases: ConformanceCase[];
}

/** The serializable result of executing every case in a conformance suite.
    `pending` names the cases that were carried but not run; `omitted` names the
    ones that ran and found the optional member they cover absent. `ok` is keyed
    off failures alone, because neither a promise nobody has made yet nor a
    legally unserved family is a broken one.
    Every case lands in exactly one bucket: `passed + pending.length +
    omitted.length + failures.length === cases.length`. */
export interface ConformanceReport {
  seam: string;
  passed: number;
  pending: string[];
  omitted: Array<{ name: string; reason: string }>;
  failures: Array<{ name: string; error: string }>;
  ok: boolean;
}

/** Executes all cases without stopping at the first failure. */
export async function runConformance(suite: ConformanceSuite): Promise<ConformanceReport> {
  const failures: ConformanceReport["failures"] = [];
  const omissions: ConformanceReport["omitted"] = [];
  const pending: string[] = [];
  let passed = 0;
  for (const conformanceCase of suite.cases) {
    if (conformanceCase.pending !== undefined) {
      pending.push(conformanceCase.name);
      continue;
    }
    try {
      const answer = await conformanceCase.run();
      if (answer === undefined) passed += 1;
      else omissions.push({ name: conformanceCase.name, reason: answer.omitted });
    } catch (error) {
      failures.push({
        name: conformanceCase.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { seam: suite.seam, passed, pending, omitted: omissions, failures, ok: failures.length === 0 };
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

      /** 01-core §12: an adapter that offers `claim` must make it a
          compare-and-set over the whole value — true for the one caller whose
          expectation still holds, false for everyone else. Both halves of the
          capability are OPTIONAL (an adapter with no database-level
          compare-and-claim omits them), so an adapter that does not offer one
          passes by not offering it; what it may not do is offer one that lies.
          These three moved off the retired generic records WIRE family, whose
          seven verbs the hosted store no longer serves: the behavior they pin
          is the BYO seam's, and this is where a BYO adapter meets it. */
      readyAdapterCase(opts, "01-core §12 — records.claim returns true on match, false on mismatch", async (adapter) => {
        const records = adapter.records("conformance_claim");
        if (records.claim === undefined) return;
        await records.put({ id: "cl1", data: { v: 1 }, refs: { o: "a" } });
        assert(await records.claim({ id: "cl1", data: { v: 999 } }) === false, "claim should return false on mismatch");
        assert(
          await records.claim({ id: "cl1", data: { v: 1 }, refs: { o: "a" } }, { data: { v: 2 }, refs: { o: "b" } }) === true,
          "claim should return true on match",
        );
        assertDeepEqual((await records.get("cl1"))?.data, { v: 2 }, "claim did not apply replacement");
      }),

      /** 01-core §12: insertIfAbsent is insert-once — the second caller is told
          it lost, and the first caller's row is left exactly as written. */
      readyAdapterCase(opts, "01-core §12 — records.insertIfAbsent returns record on first call, null on second", async (adapter) => {
        const records = adapter.records("conformance_insert_if_absent");
        if (records.atomic === undefined) return;
        const first = await records.atomic.insertIfAbsent({ id: "iia1", data: { n: 1 } });
        assert(first !== null, "insertIfAbsent first call should return a record");
        assert(first.id === "iia1", "insertIfAbsent did not echo id");
        assert(await records.atomic.insertIfAbsent({ id: "iia1", data: { n: 2 } }) === null, "insertIfAbsent second call should return null");
        assertDeepEqual((await records.get("iia1"))?.data, { n: 1 }, "insertIfAbsent overwrote existing record");
      }),

      /** 01-core §12: compareAndSwap lands only on the revision the caller
          read; a stale revision is null at the seam, never an error. */
      readyAdapterCase(opts, "01-core §12 — records.compareAndSwap succeeds on matching revision, null on stale", async (adapter) => {
        const records = adapter.records("conformance_compare_and_swap");
        if (records.atomic === undefined) return;
        const created = await records.put({ id: "cas1", data: { v: 1 } });
        assert(created.revision !== undefined, "put must return a revision for CAS");
        const swapped = await records.atomic.compareAndSwap({ id: "cas1", data: { v: 2 } }, created.revision);
        assert(swapped !== null, "compareAndSwap should succeed on matching revision");
        assertDeepEqual(swapped.data, { v: 2 }, "compareAndSwap did not update data");
        assert(
          await records.atomic.compareAndSwap({ id: "cas1", data: { v: 3 } }, created.revision) === null,
          "compareAndSwap should return null on stale revision",
        );
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

      /** 01-core §12: the replay ledger behind `Idempotency-Key`. A fresh key
          tells the caller to go do the work; the same key with the same body
          gets the recorded answer back instead of applying the mutation twice.
          OPTIONAL, on `RecordStore.claim`'s rule — an adapter that cannot
          colocate a ledger with its mutations omits it and passes here by not
          claiming one. */
      readyAdapterCase(opts, "01-core §12 — idempotency.check is null when fresh and replays what record wrote", async (adapter) => {
        const ledger = adapter.idempotency;
        if (ledger === undefined) return;
        const scope = { tenant: "tenant_a", op: "workspace.commit", key: "idem_1" };
        assert(await ledger.check(scope, "hash_a") === null, "a key nobody has recorded should check as null");
        await ledger.record(scope, "hash_a", { status: 200, result: { committed: 1 } });
        assertDeepEqual(
          await ledger.check(scope, "hash_a"),
          { status: 200, result: { committed: 1 } },
          "the replay did not return the recorded status and result",
        );
      }),

      /** 01-core §12: the same key with a DIFFERENT body is not a replay, it is
          a client bug — and returning some other request's result for it is the
          one failure this shape exists to make impossible. The hash is passed
          IN so the comparison cannot be skipped at a call site. */
      readyAdapterCase(opts, "01-core §12 — idempotency.check refuses a held key carrying a different request", async (adapter) => {
        const ledger = adapter.idempotency;
        if (ledger === undefined) return;
        const scope = { tenant: "tenant_a", op: "workspace.commit", key: "idem_2" };
        await ledger.record(scope, "hash_a", { status: 200, result: { committed: 1 } });
        const refusal = await ledger.check(scope, "hash_b").then(() => null, (error: unknown) => error);
        assert(
          (refusal as { code?: unknown } | null)?.code === "conflict",
          `a held key checked with a different request hash should throw conflict, got ${String(refusal)}`,
        );
      }),

      /** 01-core §12: first writer wins. A replay that has already been handed
          an answer must keep getting THAT answer — a second `record` landing
          over it would change history under a caller who already read it. */
      readyAdapterCase(opts, "01-core §12 — idempotency.record does not overwrite a key already held", async (adapter) => {
        const ledger = adapter.idempotency;
        if (ledger === undefined) return;
        const scope = { tenant: "tenant_a", op: "workspace.commit", key: "idem_3" };
        await ledger.record(scope, "hash_a", { status: 200, result: { attempt: 1 } });
        await ledger.record(scope, "hash_a", { status: 500, result: { attempt: 2 } });
        assertDeepEqual(
          await ledger.check(scope, "hash_a"),
          { status: 200, result: { attempt: 1 } },
          "a second record replaced the answer a replay had already been given",
        );
      }),

      /** 01-core §12: `tenant` and `op` are part of the key, not decoration. A
          mount serving many tenants out of one schema would otherwise let one
          tenant's "req_1" answer another's, and a key reused across two ops
          would replay the wrong mutation's result. */
      readyAdapterCase(opts, "01-core §12 — idempotency keys are isolated across tenant and op", async (adapter) => {
        const ledger = adapter.idempotency;
        if (ledger === undefined) return;
        const held = { tenant: "tenant_a", op: "workspace.commit", key: "shared" };
        await ledger.record(held, "hash_a", { status: 200, result: { whose: "tenant_a" } });
        assert(
          await ledger.check({ ...held, tenant: "tenant_b" }, "hash_a") === null,
          "another tenant's key replayed this tenant's answer",
        );
        assert(
          await ledger.check({ ...held, op: "lifecycle.erase" }, "hash_a") === null,
          "the same key on another op replayed the first op's answer",
        );
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
  confirmEachDescriptor: ToolDescriptor;
  confirmEachCall: ToolCall;
  readDescriptor: ToolDescriptor;
  readCall: ToolCall;
  sampleAuditEvent: AuditEvent;
}): ConformanceSuite {
  return {
    seam: "Guard",
    cases: [
      {
        /** 01-core §6: check returns a GuardDecision for confirmEach and read calls. */
        name: "01-core §6 — check returns schema-valid decisions",
        async run(): Promise<void> {
          const guard = await opts.makeGuard();
          assertParses(guardDecisionSchema, await guard.check(opts.confirmEachCall, opts.confirmEachDescriptor, opts.ctx), "confirmEach decision is invalid");
          assertParses(guardDecisionSchema, await guard.check(opts.readCall, opts.readDescriptor, opts.ctx), "read decision is invalid");
        },
      },
      {
        /** 01-core §4 and 05-guard §2 step 1: confirmEach is an unsuppressible ask. */
        name: "01-core §4; 05-guard §2 step 1 — confirmEach always asks with frozen descriptor and input preview",
        async run(): Promise<void> {
          const guard = await opts.makeGuard();
          const decision = assertParses(
            guardDecisionSchema,
            await guard.check(opts.confirmEachCall, opts.confirmEachDescriptor, opts.ctx),
            "confirmEach decision is invalid",
          );
          assert(decision.action === "ask", "confirmEach descriptor did not yield ask");
          assert(decision.decidedBy === "confirmEach", "confirmEach ask was not decidedBy confirmEach");
          assert(decision.approval.inputPreview.trim().length > 0, "confirmEach approval inputPreview is empty");
          assertDeepEqual(decision.approval.descriptor, opts.confirmEachDescriptor, "approval descriptor was not frozen from the asked descriptor");
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
