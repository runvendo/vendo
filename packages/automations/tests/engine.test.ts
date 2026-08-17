import {
  DEFAULT_RUNNER_NAME,
  descriptorHash,
  reconcileAutomations,
  type AgentRunner,
  type ApprovalId,
  type AuditEvent,
  type AutomationRecord,
  type CreateAutomationInput,
  type GrantId,
  type Guard,
  type Json,
  type MintGrantInput,
  type RecordStore,
  type RunContext,
  type StoreAdapter,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
  type VendoRecord,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { automationsInternals, createAutomations, type AutomationsEngine } from "../src/index.js";

const NOW = new Date("2026-07-12T12:00:00.000Z");

const readTool: ToolDescriptor = {
  name: "read_data",
  description: "Read data",
  inputSchema: { type: "object" },
  risk: "read",
};

const writeTool: ToolDescriptor = {
  name: "write_data",
  description: "Write data",
  inputSchema: { type: "object" },
  risk: "write",
};

const criticalTool: ToolDescriptor = {
  name: "critical_action",
  description: "Do a critical action",
  inputSchema: { type: "object" },
  risk: "destructive",
  confirmEach: true,
};

const ctx = (subject = "user_a"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

/** The ONE create op, with this suite's defaults: a code-authored record the
 *  calling ctx speaks for. There is no public create — every authoring door
 *  goes through `automationsInternals`, so the tests do too. */
const create = async (
  engine: AutomationsEngine,
  input: Omit<CreateAutomationInput, "owner" | "authoredBy"> & Partial<CreateAutomationInput>,
  runCtx: RunContext = ctx(),
): Promise<AutomationRecord> =>
  await automationsInternals(engine).create(
    { owner: runCtx.principal, authoredBy: "code", ...input },
    runCtx,
  );

/** Boot-time agent registration, which is where a goal record's `agent` name is
 *  turned back into a brain. */
const register = (engine: AutomationsEngine, runner: AgentRunner, name = DEFAULT_RUNNER_NAME): AutomationsEngine => {
  automationsInternals(engine).runners.register(name, runner);
  return engine;
};

class GuardDouble implements Guard {
  readonly audit: AuditEvent[] = [];
  /** The optional spend seam (05 §2 amendment), scripted. Left unset by default
   *  so every existing case still exercises the pre-seam fallback path. */
  spendApproval?: (id: ApprovalId) => Promise<"spent" | "already-spent" | "taken-back">;
  /** The optional mint seam, scripted. Left unset by default so every existing
   *  case still exercises the local-write fallback a custom guard leaves us. */
  mintGrant?: (input: MintGrantInput) => Promise<GrantId>;
  /** Ids passed to {@link abandonApprovals}, in order. */
  readonly abandoned: ApprovalId[] = [];
  /** The store this double writes abandonment through, so a test can read the
   *  approval row back and see the ask actually closed rather than trusting that
   *  the seam was called. Set by the tests that exercise abandonment. */
  store?: StoreAdapter;
  private readonly callbacks = new Set<(id: ApprovalId, approved: boolean) => void>();

  /** The real guard's contract in miniature: deny as `system` (never a
   *  standing no), idempotent, mint nothing, then fire the decision callbacks
   *  the same way an explicit denial does. */
  async abandonApprovals(ids: ApprovalId[]): Promise<void> {
    for (const id of ids) {
      this.abandoned.push(id);
      const record = await this.store?.records("vendo_approvals").get(id);
      if (record == null) continue;
      const data = record.data as Record<string, unknown>;
      if (data.status !== "pending") continue;
      await this.store!.records("vendo_approvals").put({
        id,
        data: { ...data, status: "denied", deniedBy: "system" },
      });
      for (const callback of this.callbacks) callback(id, false);
    }
  }

  async check(): Promise<{ action: "run"; decidedBy: "default" }> {
    return { action: "run", decidedBy: "default" };
  }

  async report(event: AuditEvent): Promise<void> {
    this.audit.push(structuredClone(event));
  }

  async directions(): Promise<string[]> { return []; }

  onApprovalDecision(callback: (id: ApprovalId, approved: boolean) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  decide(id: string, approved: boolean): void {
    for (const callback of this.callbacks) callback(id, approved);
  }
}

const registry = (
  descriptors: ToolDescriptor[] = [],
  execute: (call: ToolCall, runCtx: RunContext) => Promise<ToolOutcome> = async () => ({ status: "ok", output: {} }),
): ToolRegistry => ({
  async descriptors() { return descriptors; },
  execute,
});

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const memoryStoreWithoutAtomic = (): StoreAdapter => {
  const base = memoryStoreAdapter();
  return {
    ensureSchema: () => base.ensureSchema(),
    blobs: (namespace) => base.blobs(namespace),
    records(collection) {
      const records = base.records(collection);
      return {
        get: (id) => records.get(id),
        put: (record) => records.put(record),
        delete: (id) => records.delete(id),
        list: (query) => records.list(query),
      };
    },
  };
};

const sign = async (secret: string, deliveryId: string, timestamp: string, body: string): Promise<string> => {
  let normalized = secret.replace(/-/g, "+").replace(/_/g, "/");
  normalized += "=".repeat((4 - normalized.length % 4) % 4);
  const keyBytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${deliveryId}.${timestamp}.${body}`)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** A GENERIC records store: it stores exactly what each writer passes and
 *  derives nothing — the posture of a BYO or cloud-hosted StoreAdapter. The
 *  conformance memory adapter cannot play this part: `vendo_approvals` is a
 *  reserved collection there, so it derives subject/status/call refs from the
 *  row's own data — which is exactly how the field bug stayed invisible
 *  (repo-shipped stores derived the refs; the hosted store honored the
 *  missing ones, and the arming asks vanished from every ref-filtered feed). */
function genericStore(): StoreAdapter {
  const base = memoryStoreAdapter();
  const collections = new Map<string, Map<string, VendoRecord>>();
  const rowsFor = (name: string): Map<string, VendoRecord> => {
    const existing = collections.get(name);
    if (existing !== undefined) return existing;
    const created = new Map<string, VendoRecord>();
    collections.set(name, created);
    return created;
  };
  const matches = (record: VendoRecord, refs: Record<string, string>): boolean =>
    Object.entries(refs).every(([key, value]) => record.refs?.[key] === value);
  return {
    ...base,
    records: (collection: string): RecordStore => {
      const rows = rowsFor(collection);
      return {
        async get(id) {
          return rows.get(id) ?? null;
        },
        async put(input) {
          const record: VendoRecord = {
            id: input.id,
            data: structuredClone(input.data),
            ...(input.refs === undefined ? {} : { refs: { ...input.refs } }),
            createdAt: rows.get(input.id)?.createdAt ?? NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          };
          rows.set(input.id, record);
          return record;
        },
        async delete(id) {
          rows.delete(id);
        },
        async list(query) {
          const records = [...rows.values()].filter((record) =>
            (query?.ids === undefined || query.ids.includes(record.id))
            && (query?.refs === undefined || matches(record, query.refs)));
          return { records };
        },
      };
    },
  };
}

/** THE one create operation: all four authoring doors go through it, so a
 *  redeploy REPLACES rather than conflicting, and nothing about a record's
 *  identity is decided twice. */
describe("the one create op", () => {
  let store: StoreAdapter;
  let engine: AutomationsEngine;

  beforeEach(() => {
    store = memoryStoreAdapter();
    engine = createAutomations({ tools: registry([readTool]), guard: new GuardDouble(), store, now: () => NOW });
  });

  it("replaces a stored id rather than conflicting, and never rotates the webhook secret", async () => {
    const first = await create(engine, {
      id: "atm_replace",
      when: { webhook: "github" },
      task: { kind: "steps", steps: [{ id: "a", tool: readTool.name }] },
    });
    expect(first.webhookSecret).toEqual(expect.any(String));

    const second = await create(engine, {
      id: "atm_replace",
      when: { webhook: "github" },
      task: { kind: "goal", prompt: "do it differently" },
    });

    // A redeploy re-running create with a stored id is the NORMAL case. Rotating
    // the signing key there would silently break every sender already pointed at
    // the door, so it is minted once and survives every replace.
    expect(second).toMatchObject({
      id: first.id,
      webhookSecret: first.webhookSecret,
      createdAt: first.createdAt,
      task: { kind: "goal" },
    });
    expect((await store.records("vendo_automations").list()).records).toHaveLength(1);
  });

  it("starts a schedule's cursor NOW, and a replace leaves that cursor exactly where it was", async () => {
    await create(engine, { id: "atm_cursor_keep", when: "0 9 * * *", task: { kind: "steps", steps: [] } });
    const cursor = await store.records("automations:schedule").get("atm_cursor_keep");
    expect(cursor?.data).toEqual({ lastFiredAt: NOW.toISOString() });

    await create(engine, { id: "atm_cursor_keep", when: "0 9 * * *", task: { kind: "steps", steps: [] } });

    expect(await store.records("automations:schedule").get("atm_cursor_keep")).toEqual(cursor);
  });

  it("refuses to mint an automation owned by a principal the caller does not speak for", async () => {
    await expect(create(
      engine,
      { id: "atm_forbidden", owner: { kind: "user", subject: "user_b" }, when: { event: "go" }, task: { kind: "steps", steps: [] } },
      ctx("user_a"),
    )).rejects.toMatchObject({ code: "forbidden" });
  });

  it("mints for an ORG the caller's memberships assert, so a promoted record has an author", async () => {
    const member: RunContext = { ...ctx("user_kim"), memberships: [{ org: "maple" }] };

    const record = await create(
      engine,
      { id: "atm_org", owner: { kind: "org", subject: "maple" }, when: { event: "go" }, task: { kind: "steps", steps: [] } },
      member,
    );

    expect(record.owner).toEqual({ kind: "org", subject: "maple" });
    expect(await engine.get(record.id, member)).toMatchObject({ id: record.id });
  });

  it("keeps the webhook secret out of every read door — a listed secret is a published secret", async () => {
    const record = await create(engine, {
      id: "atm_redacted",
      when: { webhook: "stripe" },
      task: { kind: "steps", steps: [] },
    });
    expect(record.webhookSecret).toEqual(expect.any(String));

    expect(await engine.get(record.id, ctx())).not.toHaveProperty("webhookSecret");
    expect(await engine.list({}, ctx())).toEqual([expect.not.objectContaining({ webhookSecret: expect.anything() })]);
    // …and it is still on disk, because the webhook door is the one reader.
    expect((await store.records("vendo_automations").get(record.id))?.data)
      .toMatchObject({ webhookSecret: record.webhookSecret });
  });

  it("filters list by owner and by agent, and answers empty for a subject the caller cannot speak for", async () => {
    await create(engine, { id: "atm_mine", when: { event: "go" }, task: { kind: "goal", prompt: "x" }, agent: "researcher" });
    await create(engine, { id: "atm_mine_2", when: { event: "go" }, task: { kind: "steps", steps: [] } });

    expect((await engine.list({ agent: "researcher" }, ctx())).map((row) => row.id)).toEqual(["atm_mine"]);
    expect(await engine.list({ owner: "user_b" }, ctx())).toEqual([]);
    expect(await engine.get("atm_mine", ctx("user_b"))).toBeNull();
  });
});

/** A reconcile applies a plan core computed. Two disarm reasons share one
 *  `armed` flag, and the presence of `disarmedBy` IS the distinction — so the
 *  seam is driven end to end here: real records in, core's real diff, the
 *  engine's real writes. */
describe("reconcile", () => {
  const declaration = { id: "weekly", when: "0 9 * * 1", task: { kind: "steps" as const, steps: [] } };
  let store: StoreAdapter;
  let engine: AutomationsEngine;

  const plan = async (declared: Array<typeof declaration>) =>
    reconcileAutomations(declared, await engine.list({}, ctx()), ctx().principal, "code");

  beforeEach(() => {
    store = memoryStoreAdapter();
    engine = createAutomations({ tools: registry([readTool]), guard: new GuardDouble(), store, now: () => NOW });
  });

  it("disarms what the code no longer declares WITHOUT stamping disarmedBy — a machine is not a person", async () => {
    const { created } = await automationsInternals(engine).reconcile(await plan([declaration]), ctx());
    expect(created.map((row) => row.armed)).toEqual([true]);

    const applied = await automationsInternals(engine).reconcile(await plan([]), ctx());

    expect(applied.disarmed).toEqual([created[0]!.id]);
    const stored = await engine.get(created[0]!.id, ctx());
    expect(stored).toMatchObject({ armed: false });
    expect(stored).not.toHaveProperty("disarmedBy");
  });

  it("leaves a record a PERSON disarmed entirely alone, even against a plan that says to re-create or disarm it", async () => {
    const [record] = (await automationsInternals(engine).reconcile(await plan([declaration]), ctx())).created;
    // The plan is computed BEFORE the kill switch, which is the race the write
    // path re-checks for: a person can always disarm between the read and the
    // apply.
    const stale = await plan([declaration]);
    await engine.disable(record!.id, ctx());
    const killed = await engine.get(record!.id, ctx());

    const applied = await automationsInternals(engine).reconcile(
      { create: stale.create, disarm: [record!.id] },
      ctx(),
    );

    expect(applied).toEqual({ created: [], disarmed: [] });
    expect(await engine.get(record!.id, ctx())).toEqual(killed);
    expect(killed).toMatchObject({ armed: false, disarmedBy: "user" });
  });
});

/** Agents stay CODE and are never stored: a record names one by NAME, and the
 *  map is what turns that name back into a brain. There is no fallback brain —
 *  running someone's automation through an agent they did not name is worse than
 *  not running it, because nobody would ever find out. */
describe("the named runner map", () => {
  const report = (summary: string) => async (): Promise<{ status: "ok"; summary: string; toolCalls: [] }> =>
    ({ status: "ok", summary, toolCalls: [] });

  it("throws at REGISTRATION on a duplicate name, so a collision is a startup failure", () => {
    const engine = createAutomations({
      tools: registry(), guard: new GuardDouble(), store: memoryStoreAdapter(), now: () => NOW,
    });
    const { runners } = automationsInternals(engine);
    runners.register("researcher", report("first"));

    expect(() => runners.register("researcher", report("second"))).toThrow(/two agents are registered/);
  });

  it("dispatches a record to the agent it NAMED, and an unnamed one to the default agent", async () => {
    const store = memoryStoreAdapter();
    const engine = createAutomations({ tools: registry(), guard: new GuardDouble(), store, now: () => NOW });
    register(engine, report("the default agent ran"));
    register(engine, report("the researcher ran"), "researcher");
    await create(engine, { id: "atm_named", when: { event: "go" }, task: { kind: "goal", prompt: "x" }, agent: "researcher" });
    await create(engine, { id: "atm_unnamed", when: { event: "go" }, task: { kind: "goal", prompt: "x" } });

    const ids = await engine.emit("go", {}, ctx().principal);
    const runs = await Promise.all(ids.map(async (runId) => await engine.runs.get(runId, ctx())));

    // Order is the store's (newest record first), not the engine's business —
    // what matters is that each record reached the brain it NAMED.
    expect(runs.map((run) => [run?.agent, run?.summary])).toEqual(expect.arrayContaining([
      ["researcher", "the researcher ran"],
      [DEFAULT_RUNNER_NAME, "the default agent ran"],
    ]));
    expect(runs).toHaveLength(2);
  });

  it("fails a record naming an unregistered agent LOUDLY, and never falls back to another one", async () => {
    const store = memoryStoreAdapter();
    const engine = createAutomations({ tools: registry(), guard: new GuardDouble(), store, now: () => NOW });
    let fallbackRuns = 0;
    register(engine, async () => {
      fallbackRuns += 1;
      return { status: "ok", summary: "the wrong brain ran", toolCalls: [] };
    });
    await create(engine, { id: "atm_missing", when: { event: "go" }, task: { kind: "goal", prompt: "x" }, agent: "researcher" });

    const [runId] = await engine.emit("go", {}, ctx().principal);

    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "not-found", message: 'no agent named "researcher" is registered' },
      summary: expect.stringContaining("researcher"),
    });
    expect(fallbackRuns).toBe(0);
  });
});

describe("arming asks on a GENERIC records store", () => {
  const armWrite = async (store: StoreAdapter, id: string) => {
    const engine = createAutomations({
      tools: registry([readTool, writeTool]), guard: new GuardDouble(), store, now: () => NOW,
    });
    await create(engine, { id, when: { event: "go" }, task: { kind: "steps", steps: [{ id: "a", tool: writeTool.name }] } });
    return engine;
  };

  it("mints the approval row WITH the guard's listing refs", async () => {
    const store = genericStore();
    const engine = await armWrite(store, "atm_generic_refs");

    const result = await engine.enable("atm_generic_refs", ctx());

    // The refs every ref-filtered approvals feed queries by (the guard's
    // pending listing, its abandoned-ask sweep). A row without them is
    // counted by pendingGrants yet invisible and immortal — a debt nobody
    // can see or pay (field: linkwarden 2026-08-09, an automation card
    // "waiting on N permissions" with nothing to decide). Same rule the
    // grant mint beside this already follows: a generic StoreAdapter honors
    // exactly what is passed.
    expect((await store.records("vendo_approvals").get(result.missing[0]!.id))?.refs).toEqual({
      subject: "user_a",
      status: "pending",
      call: result.missing[0]!.call.id,
    });
  });

  it("re-stamps the refs a pre-contract pending ask is missing when arming adopts it", async () => {
    const store = genericStore();
    const engine = await armWrite(store, "atm_generic_readopt");
    const first = await engine.enable("atm_generic_readopt", ctx());
    const id = first.missing[0]!.id;
    // Strip the refs, the way rows minted before the contract existed look.
    const legacy = await store.records("vendo_approvals").get(id);
    await store.records("vendo_approvals").put({ id, data: legacy!.data });

    const second = await engine.enable("atm_generic_readopt", ctx());

    // Adopted, never re-minted — and visible again to every ref-filtered feed.
    expect(second.missing.map((request) => request.id)).toEqual([id]);
    expect((await store.records("vendo_approvals").get(id))?.refs).toEqual({
      subject: "user_a",
      status: "pending",
      call: first.missing[0]!.call.id,
    });
  });
});

describe("automations enable and grant capture", () => {
  let store: StoreAdapter;
  let guard: GuardDouble;

  beforeEach(() => {
    store = memoryStoreAdapter();
    guard = new GuardDouble();
  });

  it("computes the unique steps surface and persists guard-compatible asks", async () => {
    const engine = createAutomations({ tools: registry([readTool, writeTool]), guard, store, now: () => NOW });
    const record = await create(engine, {
      id: "atm_steps_enable",
      when: { event: "go" },
      task: { kind: "steps", steps: [
        { id: "a", tool: readTool.name },
        { id: "c", tool: readTool.name },
        { id: "d", tool: writeTool.name },
      ] },
    });

    const result = await engine.enable(record.id, ctx());

    expect(result.enabled).toBe(true);
    expect(result.missing.map((request) => request.call.tool)).toEqual([readTool.name, writeTool.name]);
    expect(result.missing[0]).toMatchObject({
      call: { id: expect.stringMatching(/^call_/), args: {} },
      descriptor: readTool,
      ctx: {
        principal: ctx().principal,
        venue: "automation",
        presence: "present",
        trigger: { automationId: record.id },
      },
      createdAt: NOW.toISOString(),
    });
    const approval = await store.records("vendo_approvals").get(result.missing[0]!.id);
    expect(approval?.data).toMatchObject({ request: result.missing[0], status: "pending" });
    expect(await store.records("automations:captures").get(result.missing[0]!.id)).toMatchObject({
      data: { automationId: record.id, subject: "user_a", tool: readTool.name, descriptorHash: descriptorHash(readTool) },
    });
  });

  /** The `vendo.json` fold-in's step list verbatim — `manifest-triggers.ts` writes
   *  `[{ id: "fire", tool: `fn:${fn}` }]` and then arms it, so this is the whole
   *  of what one of the four authoring doors asks the engine to consent to. */
  it("arms an automation whose only step is an app function, with nothing to capture", async () => {
    const engine = createAutomations({ tools: registry([readTool]), guard, store, now: () => NOW });
    const record = await create(engine, {
      id: "atm_manifest_fn",
      authoredBy: "manifest",
      when: "0 8 * * *",
      task: { kind: "steps", steps: [{ id: "fire", tool: "fn:chaseInvoices" }] },
    });

    expect(await engine.enable(record.id, ctx())).toMatchObject({ enabled: true, missing: [] });
    expect((await store.records("vendo_approvals").list()).records).toEqual([]);
  });

  /** The other half of the rule: dropping `fn:` may not widen what runs without
   *  consent. A host tool named beside an app function is still asked for. */
  it("still captures the host tool a step list names beside its app function", async () => {
    const engine = createAutomations({ tools: registry([readTool]), guard, store, now: () => NOW });
    const record = await create(engine, {
      id: "atm_mixed_fn",
      when: "0 8 * * *",
      task: { kind: "steps", steps: [
        { id: "fire", tool: "fn:chaseInvoices" },
        { id: "read", tool: readTool.name },
      ] },
    });

    expect((await engine.enable(record.id, ctx())).missing.map(({ call }) => call.tool))
      .toEqual([readTool.name]);
  });

  it("captures every descriptor for goal runs and mints or discards on decisions", async () => {
    const engine = createAutomations({ tools: registry([readTool, writeTool]), guard, store, now: () => NOW });
    const record = await create(engine, {
      id: "atm_goal_enable",
      when: { event: "go" },
      task: { kind: "goal", prompt: "do work" },
    });
    const { missing } = await engine.enable(record.id, ctx());

    guard.decide(missing[0]!.id, true);
    guard.decide(missing[1]!.id, false);
    await flush();

    const grants = await store.records("vendo_grants").list();
    expect(grants.records).toHaveLength(1);
    expect(grants.records[0]?.data).toMatchObject({
      subject: "user_a",
      tool: readTool.name,
      descriptorHash: descriptorHash(readTool),
      scope: { kind: "tool" },
      duration: "standing",
      automationId: record.id,
      source: "automation",
      grantedAt: NOW.toISOString(),
    });
    expect((await store.records("vendo_approvals").get(missing[0]!.id))?.data).toMatchObject({
      consumedAt: NOW.toISOString(),
    });
    expect((await store.records("automations:captures").list()).records).toHaveLength(0);
  });

  // The case above is the other half: a GuardDouble with no mint seam, whose
  // grant this engine writes itself from the very same buildGrant.
  it("mints THROUGH the guard when it offers the seam — one implementation, not two", async () => {
    const minted: MintGrantInput[] = [];
    guard.mintGrant = async (input) => {
      minted.push(input);
      return "grt_from_guard";
    };
    const engine = createAutomations({ tools: registry([readTool]), guard, store, now: () => NOW });
    const record = await create(engine, {
      id: "atm_guard_mint",
      when: { event: "go" },
      task: { kind: "goal", prompt: "do work" },
    });
    const { missing } = await engine.enable(record.id, ctx());

    guard.decide(missing[0]!.id, true);
    await flush();

    // Everything the grant means is told to the guard; nothing about it is
    // decided twice.
    expect(minted).toMatchObject([{
      request: { id: missing[0]!.id, call: { tool: readTool.name } },
      remember: { duration: "standing" },
      source: "automation",
      automationId: record.id,
    }]);
    // …and the engine wrote no second row of its own.
    expect((await store.records("vendo_grants").list()).records).toHaveLength(0);
  });

  it("ignores a chat-source grant, and the kill switch preserves the schedule cursor", async () => {
    const engine = createAutomations({ tools: registry([readTool]), guard, store, now: () => NOW });
    const record = await create(engine, {
      id: "atm_cursor",
      when: { every: "1h" },
      task: { kind: "steps", steps: [{ id: "read", tool: readTool.name }] },
    });
    await store.records("vendo_grants").put({
      id: "grt_existing",
      data: {
        id: "grt_existing", subject: "user_a", tool: readTool.name,
        descriptorHash: descriptorHash(readTool), scope: { kind: "tool" }, duration: "standing",
        automationId: record.id, source: "chat", grantedAt: NOW.toISOString(),
      },
      refs: { subject: "user_a", tool: readTool.name, automation_id: record.id },
    });

    expect((await engine.enable(record.id, ctx())).missing.map(({ call }) => call.tool)).toEqual([readTool.name]);
    const cursor = await store.records("automations:schedule").get(record.id);
    expect(cursor?.data).toEqual({ lastFiredAt: NOW.toISOString() });

    await engine.disable(record.id, ctx());

    expect(await engine.get(record.id, ctx())).toMatchObject({ armed: false, disarmedBy: "user" });
    expect(await store.records("automations:schedule").get(record.id)).toEqual(cursor);
  });

  it("re-arming clears the kill switch, so a reconcile can see the record again", async () => {
    const engine = createAutomations({ tools: registry([readTool]), guard, store, now: () => NOW });
    const record = await create(engine, { id: "atm_rearm", when: { event: "go" }, task: { kind: "steps", steps: [] } });
    await engine.disable(record.id, ctx());

    await engine.enable(record.id, ctx());

    expect(await engine.get(record.id, ctx())).toMatchObject({ armed: true });
    expect(await engine.get(record.id, ctx())).not.toHaveProperty("disarmedBy");
  });

  it("mints next-firing authority when a goal run's own approval is granted", async () => {
    // Constructing the engine is the whole subject here: that is what registers
    // the guard's onApprovalDecision callback the decision below travels through.
    const engine = createAutomations({ tools: registry([writeTool]), guard, store, now: () => NOW });
    const record = await create(engine, {
      id: "atm_goal_next",
      when: { event: "go" },
      task: { kind: "goal", prompt: "write later" },
    });
    // An away approval nothing captured names no automation; the RUN it was
    // raised inside is what knows which record fired.
    const run = {
      id: "run_goal_next",
      automationId: record.id,
      owner: record.owner,
      agent: DEFAULT_RUNNER_NAME,
      trigger: { kind: "host-event" as const, event: "go" },
      status: "error" as const,
      startedAt: NOW.toISOString(),
      steps: [],
    };
    await store.records("vendo_runs").put({
      id: run.id,
      data: { automationId: record.id, trigger: run.trigger, status: run.status, record: run, startedAt: run.startedAt },
    });
    const request = {
      id: "apr_goal_next",
      call: { id: "call_goal_next", tool: writeTool.name, args: { value: 1 } },
      descriptor: writeTool,
      inputPreview: "write",
      ctx: {
        principal: ctx().principal,
        venue: "automation" as const,
        presence: "away" as const,
        trigger: { runId: run.id, kind: "host-event" as const, automationId: record.id },
      },
      createdAt: NOW.toISOString(),
    };
    await store.records("vendo_approvals").put({
      id: request.id,
      data: { request, status: "approved", decidedAt: NOW.toISOString() },
    });

    guard.decide(request.id, true);
    await flush();

    expect((await store.records("vendo_grants").list()).records[0]?.data).toMatchObject({
      subject: "user_a",
      tool: writeTool.name,
      automationId: record.id,
      source: "automation",
    });
    expect((await store.records("vendo_approvals").get(request.id))?.data).toMatchObject({
      consumedAt: NOW.toISOString(),
    });
  });

  /** Design §3's voice law — a consent sentence may never print an identifier at
   *  someone. A steps record has no name field, so its first step is what names
   *  it, and it has to arrive in words. */
  it("names a steps automation in the consent sentence in words, not in its step's identifier", async () => {
    const invoicesTool: ToolDescriptor = {
      name: "host_invoices_list",
      description: "List invoices.",
      inputSchema: { type: "object" },
      risk: "read",
    };
    const engine = createAutomations({ tools: registry([invoicesTool]), guard, store, now: () => NOW });
    const record = await create(engine, {
      id: "atm_named_steps",
      when: { event: "go" },
      task: { kind: "steps", steps: [{ id: "list", tool: invoicesTool.name }] },
    });

    const { missing } = await engine.enable(record.id, ctx());

    expect(missing[0]?.inputPreview).toContain('Allow "Invoices list" to');
  });
});

describe("grant sets: one set per enable, dedupe against pending", () => {
  let store: StoreAdapter;
  let guard: GuardDouble;
  let engine: AutomationsEngine;

  // Mirrors the demo weeklySummary capture surface: two host reads.
  const insightsTool: ToolDescriptor = {
    name: "host_getSpendingInsights",
    description: "See category totals and month-over-month trends.",
    inputSchema: { type: "object" },
    risk: "read",
  };
  const transactionsTool: ToolDescriptor = {
    name: "host_listTransactions",
    description: "Read transaction history across accounts.",
    inputSchema: { type: "object" },
    risk: "read",
  };
  const WEEKLY = "atm_weekly_set";

  beforeEach(async () => {
    store = memoryStoreAdapter();
    guard = new GuardDouble();
    engine = createAutomations({
      tools: registry([insightsTool, transactionsTool]), guard, store, now: () => NOW,
    });
    await create(engine, {
      id: WEEKLY,
      when: "0 17 * * 5",
      task: { kind: "steps", steps: [
        { id: "spending", tool: insightsTool.name },
        { id: "transactions", tool: transactionsTool.name },
      ] },
    });
  });

  it("returns one grantSetId spanning both missing asks", async () => {
    const result = await engine.enable(WEEKLY, ctx());

    expect(result.enabled).toBe(true);
    expect(result.missing).toHaveLength(2);
    expect(result.grantSetId).toEqual(expect.stringMatching(/^gset_/));
    for (const ask of result.missing) {
      expect((await store.records("automations:captures").get(ask.id))?.data).toMatchObject({
        automationId: WEEKLY,
        grantSetId: result.grantSetId,
      });
    }
  });

  /** The RECORD has to name its set, because that is where the consent surface
   *  reads it from: chrome resolves the automation through `automations.list()`
   *  and settles the whole set with the id it finds there
   *  (`packages/ui/src/chrome/thread/automation-consent.tsx`). */
  it("stamps the set on the record, so a surface holding only the id can settle it", async () => {
    const result = await engine.enable(WEEKLY, ctx());

    expect((await engine.get(WEEKLY, ctx()))?.grantSetId).toBe(result.grantSetId);
  });

  it("re-running enable() reuses the pending ask — no duplicate ApprovalRequest per (automation, tool)", async () => {
    const first = await engine.enable(WEEKLY, ctx());
    guard.decide(first.missing[0]!.id, true);
    await flush();

    const second = await engine.enable(WEEKLY, ctx());

    expect(second.missing.map((ask) => ask.call.tool)).toEqual([transactionsTool.name]);
    expect(second.missing[0]!.id).toBe(first.missing[1]!.id);
    expect(second.grantSetId).toBe(first.grantSetId);
    const approvals = await store.records("vendo_approvals").list();
    const pendingForPair = approvals.records.filter((record) => {
      const data = record.data as { status?: string; request?: { call?: { tool?: string } } };
      return data.status === "pending" && data.request?.call?.tool === transactionsTool.name;
    });
    expect(pendingForPair).toHaveLength(1);
  });

  it("adopts a capture row minted without a grantSetId instead of re-minting the ask", async () => {
    // A pre-grant-sets deployment minted this ask: capture row with NO
    // grantSetId. New code must read it (schema optional) and adopt it on the
    // next enable().
    const legacyRequest = {
      id: "apr_legacy",
      call: { id: "call_legacy", tool: insightsTool.name, args: {} },
      descriptor: insightsTool,
      inputPreview: "legacy standing ask",
      ctx: { principal: ctx().principal, venue: "automation" as const, presence: "present" as const },
      createdAt: NOW.toISOString(),
    };
    await store.records("vendo_approvals").put({
      id: legacyRequest.id,
      data: { request: legacyRequest, status: "pending" },
    });
    await store.records("automations:captures").put({
      id: legacyRequest.id,
      data: { automationId: WEEKLY, subject: "user_a", tool: insightsTool.name, descriptorHash: descriptorHash(insightsTool) },
    });

    const result = await engine.enable(WEEKLY, ctx());

    expect(result.missing.map((ask) => ask.id)).toEqual(["apr_legacy", result.missing[1]!.id]);
    expect(result.grantSetId).toEqual(expect.stringMatching(/^gset_/));
    expect((await store.records("automations:captures").get("apr_legacy"))?.data).toMatchObject({
      grantSetId: result.grantSetId,
    });
  });

  it("a fully denied set disarms the automation in the same decision — deny is transactional server-side", async () => {
    const { missing } = await engine.enable(WEEKLY, ctx());
    expect(await engine.get(WEEKLY, ctx())).toMatchObject({ armed: true });

    guard.decide(missing[0]!.id, false);
    guard.decide(missing[1]!.id, false);
    await flush();

    // No second disable request exists to fail: the row disarmed with the
    // decision itself, and no grants were minted.
    expect(await engine.get(WEEKLY, ctx())).toMatchObject({ armed: false });
    expect((await store.records("vendo_grants").list()).records).toHaveLength(0);
    // …and NOT as a person: only the kill switch stamps that.
    expect(await engine.get(WEEKLY, ctx())).not.toHaveProperty("disarmedBy");
  });

  it("a PARTIALLY granted automation stays armed on deny — the ungranted step fails loud at fire time (05 §6, J5)", async () => {
    const { missing } = await engine.enable(WEEKLY, ctx());

    guard.decide(missing[0]!.id, true);
    guard.decide(missing[1]!.id, false);
    await flush();

    expect(await engine.get(WEEKLY, ctx())).toMatchObject({ armed: true });
    expect((await store.records("vendo_grants").list()).records).toHaveLength(1);
  });

  it("deny order does not matter for partial grants: deny first, approve second still stays armed", async () => {
    const { missing } = await engine.enable(WEEKLY, ctx());

    guard.decide(missing[1]!.id, false);
    guard.decide(missing[0]!.id, true);
    await flush();

    expect(await engine.get(WEEKLY, ctx())).toMatchObject({ armed: true });
    expect((await store.records("vendo_grants").list()).records).toHaveLength(1);
  });

  it("omits grantSetId once every ask in the set is decided and nothing is missing", async () => {
    const { missing } = await engine.enable(WEEKLY, ctx());
    guard.decide(missing[0]!.id, true);
    guard.decide(missing[1]!.id, true);
    await flush();

    const again = await engine.enable(WEEKLY, ctx());

    expect(again.missing).toHaveLength(0);
    expect(again.grantSetId).toBeUndefined();
  });

  /**
   * Checker round 5, finding 2 — arming a standing grant SPENDS the approval it
   * rode in on, so it has to contend with `approvals.revoke` on the same
   * one-time transition. The engine asks the guard for that spend and grants
   * only on "spent"; the two orderings of the race itself are pinned against the
   * real receipt in `packages/guard/test/ungraded-default.test.ts`.
   */
  it("arms nothing when the person took the yes back before the callback could spend it", async () => {
    guard.spendApproval = async () => "taken-back";
    const { missing } = await engine.enable(WEEKLY, ctx());

    guard.decide(missing[0]!.id, true);
    await flush();

    expect((await store.records("vendo_grants").list()).records).toHaveLength(0);
  });

  it("arms nothing when someone else already spent the yes", async () => {
    guard.spendApproval = async () => "already-spent";
    const { missing } = await engine.enable(WEEKLY, ctx());

    guard.decide(missing[0]!.id, true);
    await flush();

    expect((await store.records("vendo_grants").list()).records).toHaveLength(0);
  });

  it("arms exactly one grant per won spend, and leaves the approval row to the guard", async () => {
    guard.spendApproval = async () => "spent";
    const { missing } = await engine.enable(WEEKLY, ctx());

    guard.decide(missing[0]!.id, true);
    await flush();

    expect((await store.records("vendo_grants").list()).records).toHaveLength(1);
    // The guard owns the row now: the engine no longer writes `consumedAt`
    // itself (which is what used to erase a concurrent take-back).
    expect((await store.records("vendo_approvals").get(missing[0]!.id))?.data)
      .not.toHaveProperty("consumedAt");
  });

  it("fallback for a Guard predating the seam: a taken-back yes arms nothing and keeps its marker", async () => {
    // No `spendApproval` on this double, so the engine takes the old write-back
    // path. It cannot linearize without a receipt, but it must still refuse the
    // take-back it can see — and must not strip `voidedAt`/`deniedBy` off the
    // row (the parse used to drop both).
    const { missing } = await engine.enable(WEEKLY, ctx());
    const takenBack = missing[0]!.id;
    const row = (await store.records("vendo_approvals").get(takenBack))?.data as Record<string, unknown>;
    await store.records("vendo_approvals").put({
      id: takenBack,
      data: { ...row, status: "approved", decidedAt: NOW.toISOString(), voidedAt: NOW.toISOString() },
    });

    guard.decide(takenBack, true);
    await flush();

    expect((await store.records("vendo_grants").list()).records).toHaveLength(0);
    expect((await store.records("vendo_approvals").get(takenBack))?.data).toMatchObject({
      voidedAt: NOW.toISOString(),
    });
  });
});

describe("steps execution and hard failures", () => {
  it("evaluates JSONata args, if, forEach, and cross-step outputs sequentially", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const calls: ToolCall[] = [];
    const tools = registry([readTool, writeTool], async (call) => {
      calls.push(structuredClone(call));
      const value = (call.args as { value: number }).value;
      return { status: "ok", output: value * 2 };
    });
    const engine = createAutomations({ tools, guard, store, now: () => NOW });
    await create(engine, {
      id: "atm_steps",
      when: { event: "calculate" },
      task: { kind: "steps", steps: [
        { id: "first", tool: readTool.name, args: { value: "event.base" } },
        { id: "skip", tool: writeTool.name, if: "false" },
        { id: "fan", tool: writeTool.name, forEach: "event.items", args: { value: "item + steps.first" } },
      ] },
    });

    const [runId] = await engine.emit("calculate", { base: 3, items: [1, 2] }, ctx().principal);
    const run = await engine.runs.get(runId!, ctx());

    expect(calls.map((call) => call.args)).toEqual([{ value: 3 }, { value: 7 }, { value: 8 }]);
    expect(run).toMatchObject({ status: "ok", summary: "3 steps ok" });
    expect(run?.steps.map((step) => step.id)).toEqual(["first", "fan", "fan"]);
    expect(guard.audit.map((event) => event.detail)).toEqual([{ status: "running" }, { status: "ok" }]);
  });

  it("fails a run on connect-required with an actionable error and a readable step record", async () => {
    const store = memoryStoreAdapter();
    const tools = registry([writeTool], async () => ({
      status: "connect-required",
      connect: { connector: "composio", toolkit: "gmail", message: "Connect your gmail account first." },
    }));
    const engine = createAutomations({ tools, guard: new GuardDouble(), store, now: () => NOW });
    await create(engine, {
      id: "atm_connect",
      when: { event: "send" },
      task: { kind: "steps", steps: [{ id: "send", tool: writeTool.name }] },
    });

    const [runId] = await engine.emit("send", {}, ctx().principal);

    // The persisted record must READ BACK through the run schema — the step
    // outcome enum includes connect-required (an away run has no user to show
    // a connect card to; it fails with the actionable connect message).
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "connect-required", message: "Connect your gmail account first." },
      steps: [{ id: "send", outcome: "connect-required", detail: "Connect your gmail account first." }],
    });
  });

  it("contains oversized forEach fan-out", async () => {
    const store = memoryStoreAdapter();
    let calls = 0;
    const tools = registry([writeTool], async () => {
      calls += 1;
      return { status: "ok", output: {} };
    });
    const engine = createAutomations({ tools, guard: new GuardDouble(), store, now: () => NOW });
    await create(engine, {
      id: "atm_fanout_cap",
      when: { event: "fan" },
      task: { kind: "steps", steps: [{ id: "fan", tool: writeTool.name, forEach: "event.items" }] },
    });

    const [fanoutId] = await engine.emit("fan", { items: Array.from({ length: 1001 }, (_, index) => index) }, ctx().principal);

    expect(await engine.runs.get(fanoutId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "validation", message: "step fan forEach exceeds 1000 items" },
    });
    expect(calls).toBe(0);
  });

  it("keeps a stopped terminal row when a slow deterministic step returns", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const tools = registry([readTool], async () => {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return { status: "ok", output: { late: true } };
    });
    const engine = createAutomations({ tools, guard, store, now: () => NOW });
    const controller = createAutomations({ tools, guard, store, now: () => NOW });
    await create(engine, {
      id: "atm_slow_stop",
      when: { event: "slow" },
      task: { kind: "steps", steps: [{ id: "slow", tool: readTool.name }] },
    });
    const emitted = engine.emit("slow", {}, ctx().principal);
    await didStart;
    const running = (await engine.runs.list({ status: "running" }, ctx())).runs[0]!;

    await controller.runs.stop(running.id, ctx());
    release();
    await emitted;

    expect(await engine.runs.get(running.id, ctx())).toMatchObject({ status: "stopped", summary: "stopped by user" });
    expect(guard.audit.map((event) => (event.detail as { status: string }).status)).toEqual(["running", "stopped"]);
  });
});

/** S2 — fail-loud consent. A run that meets a permission it does not hold
 *  stops LOUDLY at that step: the ask is captured (so the ONE existing decision
 *  path mints the standing grant), the run lands on a terminal `error` row
 *  naming what it needed, and the person taps Grant & re-run. Nothing is parked,
 *  nothing is resumed, nothing is replayed. */
describe("fail-loud consent and re-run", () => {
  /** A registry whose `write_data` answers pending-approval the first N times it
   *  is called — the guard's own answer for a call with no standing grant — and
   *  runs afterwards. Every call is recorded so a test can prove what executed. */
  const missingPermission = (store: StoreAdapter, misses = 1) => {
    const calls: ToolCall[] = [];
    let seen = 0;
    const tools = registry([readTool, writeTool], async (call, runCtx) => {
      calls.push(structuredClone(call));
      if (call.tool !== writeTool.name) return { status: "ok", output: { read: true } };
      seen += 1;
      if (seen > misses) return { status: "ok", output: "granted" };
      const request = {
        id: `apr_miss_${seen}`,
        call: structuredClone(call),
        descriptor: writeTool,
        inputPreview: "write",
        ctx: {
          principal: runCtx.principal,
          venue: runCtx.venue,
          presence: runCtx.presence,
          trigger: runCtx.trigger,
        },
        createdAt: NOW.toISOString(),
      };
      await store.records("vendo_approvals").put({ id: request.id, data: { request, status: "pending" } });
      return { status: "pending-approval", approvalId: request.id };
    });
    return { tools, calls };
  };

  const threeSteps = { kind: "steps" as const, steps: [
    { id: "read", tool: readTool.name },
    { id: "write", tool: writeTool.name, args: { value: "event.value" } },
    { id: "after", tool: readTool.name },
  ] };

  it("stops the run at the missing permission, names the tool, and captures the ask", async () => {
    const store = memoryStoreAdapter();
    const { tools, calls } = missingPermission(store);
    const engine = createAutomations({ tools, guard: new GuardDouble(), store, now: () => NOW });
    const record = await create(engine, { id: "atm_miss", when: { event: "go" }, task: threeSteps });

    const [runId] = await engine.emit("go", { value: 4 }, ctx().principal);

    // The run is TERMINAL and loud: a person can see what it needed and that
    // nothing after it ran.
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "needs-permission", tool: writeTool.name },
      steps: [
        { id: "read", outcome: "ok" },
        { id: "write", outcome: "pending-approval", detail: "apr_miss_1" },
      ],
    });
    expect((await engine.runs.get(runId!, ctx()))?.error?.message).toContain(writeTool.name);
    expect(calls.map((call) => call.tool)).toEqual([readTool.name, writeTool.name]);
    // …and the ask is a CAPTURE, the same shape arming writes, so the standing
    // grant is minted by the one decision path both doors share.
    const capture = await store.records("automations:captures").get("apr_miss_1");
    expect(capture?.data).toMatchObject({
      automationId: record.id,
      subject: "user_a",
      tool: writeTool.name,
      descriptorHash: descriptorHash(writeTool),
    });
    expect((capture?.data as { grantSetId?: string }).grantSetId).toMatch(/^gset_/);
  });

  it("supersedes the arming ask with the away ask the run raised for the same permission", async () => {
    // The state a real deployment reaches constantly: the person armed the
    // automation and left the consent card undecided, so an arming ask for
    // `write_data` is pending — and THEN the event arrived and the run met the
    // same permission.
    //
    // One thing to allow is one question, so only one of the pair may stay
    // pending. WHICH one is not a toss-up. The away ask is raised inside the run
    // and carries `presence: "away"` and its run id; the arming ask is a
    // present-time chat-venue row with neither. Keeping the arming one and
    // closing the away one erases away provenance from the approvals record —
    // the thing every away-authority rule is enforced against — so the away ask
    // is the survivor and the arming ask is what gets superseded.
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    guard.store = store;
    const { tools } = missingPermission(store);
    const engine = createAutomations({ tools, guard, store, now: () => NOW });
    const record = await create(engine, { id: "atm_orphan", when: { event: "go" }, task: threeSteps });

    const { missing } = await engine.enable(record.id, ctx());
    const armingWrite = missing.find((request) => request.call.tool === writeTool.name);
    const armingRead = missing.find((request) => request.call.tool === readTool.name);
    expect(armingWrite).toBeDefined();
    expect(armingRead).toBeDefined();

    const [runId] = await engine.emit("go", { value: 4 }, ctx().principal);
    await flush();

    // The run still fails loudly for the right reason — that part was never wrong.
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "needs-permission", tool: writeTool.name },
    });

    // The AWAY ask survives, still pending, still answerable — it is the row a
    // surface renders the failed run's card from, and the only one that says
    // this permission was met while nobody was watching.
    const away = (await store.records("vendo_approvals").get("apr_miss_1"))!.data as {
      status: string;
      request: { ctx: { presence?: string; venue?: string; trigger?: { automationId?: string } } };
    };
    expect(away.status).toBe("pending");
    expect(away.request.ctx).toMatchObject({
      presence: "away",
      venue: "automation",
      trigger: { automationId: record.id },
    });

    // The redundant ARMING ask is the one closed, as `system` so it can never
    // read as the person having said no to this tool.
    expect(guard.abandoned).toEqual([armingWrite!.id]);
    expect(await store.records("vendo_approvals").get(armingWrite!.id))
      .toMatchObject({ data: { status: "denied", deniedBy: "system" } });

    // The capture MOVED rather than being dropped or duplicated: the question is
    // still outstanding, still in the same grant set, now keyed by the away ask.
    // A capture left on the closed arming ask would keep a settled question open;
    // no capture at all would orphan a pending ask no surface counts.
    expect((await store.records("automations:captures").get("apr_miss_1"))?.data)
      .toMatchObject({ automationId: record.id, tool: writeTool.name });
    expect(await store.records("automations:captures").get(armingWrite!.id)).toBeNull();

    // The untouched read ask is still open, and superseding granted nothing —
    // a deny that disarmed here would switch off an automation nobody said no to.
    expect(await store.records("vendo_approvals").get(armingRead!.id))
      .toMatchObject({ data: { status: "pending" } });
    expect((await store.records("vendo_grants").list()).records).toHaveLength(0);
    expect(await engine.get(record.id, ctx())).toMatchObject({ armed: true });
  });

  it("mints the standing grant on approval and re-runs the automation fresh", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const { tools, calls } = missingPermission(store);
    const engine = createAutomations({ tools, guard, store, now: () => NOW });
    const record = await create(engine, { id: "atm_rerun", when: { event: "go" }, task: threeSteps });
    const [runId] = await engine.emit("go", { value: 4 }, ctx().principal);

    await store.records("vendo_approvals").put({
      id: "apr_miss_1",
      data: {
        ...((await store.records("vendo_approvals").get("apr_miss_1"))?.data as object),
        status: "approved",
        decidedAt: NOW.toISOString(),
      },
    });
    guard.decide("apr_miss_1", true);
    await flush();

    expect((await store.records("vendo_grants").list()).records[0]?.data).toMatchObject({
      subject: "user_a",
      tool: writeTool.name,
      automationId: record.id,
      source: "automation",
      duration: "standing",
    });
    expect(await store.records("automations:captures").get("apr_miss_1")).toBeNull();

    const rerunId = await engine.runs.rerun(runId!, ctx());

    // A FRESH run: its own row, its own id, the original triggering event.
    expect(rerunId).not.toBe(runId);
    expect(await engine.runs.get(rerunId, ctx())).toMatchObject({
      automationId: record.id,
      status: "ok",
      summary: "3 steps ok",
    });
    // The failed run stays exactly as it was — a re-run is a new attempt, not an
    // edit of the record of what happened.
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({ status: "error" });
    // The write ran with the event of the run being re-run.
    expect(calls.at(-2)).toMatchObject({ tool: writeTool.name, args: { value: 4 } });
  });

  it("re-runs the record that FIRED, so editing the steps cannot move a completed call's identity", async () => {
    // The effect ledger tells "this call again" from "another call just like it"
    // by call id, and a steps call id is positional. That is only stable if the
    // re-run reads the same step list — so the re-run has to fire the record that
    // actually fired, not whatever is stored now. Otherwise inserting a step
    // ahead of one that already completed renumbers it, its receipt is never
    // found, and work that already landed happens twice.
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const { tools, calls } = missingPermission(store);
    const engine = createAutomations({ tools, guard, store, now: () => NOW });
    await create(engine, { id: "atm_rerun_edited", when: { event: "go" }, task: threeSteps });
    const [runId] = await engine.emit("go", { value: 4 }, ctx().principal);

    // Step 0 completed before step 1 asked for a permission nobody held.
    const completed = calls.find((call) => call.tool === readTool.name);
    expect(completed).toBeDefined();

    await store.records("vendo_approvals").put({
      id: "apr_miss_1",
      data: {
        ...((await store.records("vendo_approvals").get("apr_miss_1"))?.data as object),
        status: "approved",
        decidedAt: NOW.toISOString(),
      },
    });
    guard.decide("apr_miss_1", true);
    await flush();

    // The author inserts a step AHEAD of the one that already ran, between the
    // failure and the re-run — the same id, so it REPLACES.
    await create(engine, {
      id: "atm_rerun_edited",
      when: { event: "go" },
      task: { kind: "steps", steps: [{ id: "inserted", tool: readTool.name }, ...threeSteps.steps] },
    });

    const before = calls.length;
    await engine.runs.rerun(runId!, ctx());

    expect(calls.slice(before).map((call) => call.id)).toContain(completed!.id);
  });

  it("refuses a re-run for a caller who does not hold the automation, and an unknown run", async () => {
    const store = memoryStoreAdapter();
    const { tools } = missingPermission(store);
    const engine = createAutomations({ tools, guard: new GuardDouble(), store, now: () => NOW });
    await create(engine, { id: "atm_rerun_gate", when: { event: "go" }, task: threeSteps });
    const [runId] = await engine.emit("go", { value: 1 }, ctx().principal);

    await expect(engine.runs.rerun(runId!, ctx("user_b"))).rejects.toMatchObject({ code: "not-found" });
    await expect(engine.runs.rerun("run_nope", ctx())).rejects.toMatchObject({ code: "not-found" });
  });

  it("refuses a re-run of an automation nobody has armed", async () => {
    const store = memoryStoreAdapter();
    const { tools } = missingPermission(store);
    const engine = createAutomations({ tools, guard: new GuardDouble(), store, now: () => NOW });
    const record = await create(engine, { id: "atm_rerun_off", when: { event: "go" }, task: threeSteps });
    const [runId] = await engine.emit("go", { value: 1 }, ctx().principal);
    await engine.disable(record.id, ctx());

    await expect(engine.runs.rerun(runId!, ctx())).rejects.toMatchObject({ code: "conflict" });
  });

  it("mints nothing when the yes was taken back before the capture could spend it", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    guard.spendApproval = async () => "taken-back";
    const { tools } = missingPermission(store);
    const engine = createAutomations({ tools, guard, store, now: () => NOW });
    await create(engine, { id: "atm_miss_takeback", when: { event: "go" }, task: threeSteps });
    const [runId] = await engine.emit("go", { value: 4 }, ctx().principal);

    guard.decide("apr_miss_1", true);
    await flush();

    expect((await store.records("vendo_grants").list()).records).toHaveLength(0);
    // The run's own verdict is untouched by the decision either way.
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "needs-permission" },
    });
  });

  it("leaves the run in error and mints nothing when the ask is denied", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const { tools } = missingPermission(store);
    const engine = createAutomations({ tools, guard, store, now: () => NOW });
    await create(engine, { id: "atm_miss_deny", when: { event: "go" }, task: threeSteps });
    const [runId] = await engine.emit("go", { value: 4 }, ctx().principal);

    guard.decide("apr_miss_1", false);
    await flush();

    expect((await store.records("vendo_grants").list()).records).toHaveLength(0);
    expect(await store.records("automations:captures").get("apr_miss_1")).toBeNull();
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "needs-permission" },
    });
  });
});

describe("schedule, webhook, and host triggers", () => {
  const noop = { kind: "steps" as const, steps: [] };

  it("fires due cron/every/at schedules once, collapses missed windows, and never backfills", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const calls: Json[] = [];
    const tools = registry([readTool], async (call) => {
      calls.push(call.args);
      return { status: "ok", output: {} };
    });
    const engine = createAutomations({ tools, guard, store, now: () => NOW });
    const peer = createAutomations({ tools, guard: new GuardDouble(), store, now: () => NOW });
    const schedules = [
      ["atm_cron", "* * * * *"],
      ["atm_every", { every: "15m" }],
      ["atm_at", { at: "2026-07-12T10:00:00.000Z" }],
    ] as const;
    for (const [id, when] of schedules) {
      await create(engine, {
        id,
        when,
        task: { kind: "steps", steps: [{ id: "run", tool: readTool.name, args: { event: "event" } }] },
      });
      await store.records("automations:schedule").put({ id, data: { lastFiredAt: "2026-07-12T08:00:00.000Z" } });
    }

    const [firstTick, secondTick] = await Promise.all([engine.tick(), peer.tick()]);

    expect([...firstTick, ...secondTick]).toHaveLength(3);
    expect(calls).toHaveLength(3);
    expect((calls[0] as { event: { firedAt: string } }).event.firedAt).toBe(NOW.toISOString());
    expect((await store.records("automations:schedule").get("atm_at"))?.data)
      .toMatchObject({ firedAt: NOW.toISOString() });
    // The cursor advanced, so the next tick has nothing due and fires nothing.
    await expect(engine.tick()).resolves.toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("retains single-instance schedule behavior when the atomic capability is absent", async () => {
    const store = memoryStoreWithoutAtomic();
    const engine = createAutomations({ tools: registry(), guard: new GuardDouble(), store, now: () => NOW });
    await create(engine, { id: "atm_schedule_fallback", when: { every: "15m" }, task: noop });
    await store.records("automations:schedule").put({
      id: "atm_schedule_fallback",
      data: { lastFiredAt: "2026-07-12T08:00:00.000Z" },
    });

    await expect(engine.tick()).resolves.toHaveLength(1);
  });

  it.each([
    ["atomic", memoryStoreAdapter],
    ["non-atomic", memoryStoreWithoutAtomic],
  ])("initializes a future schedule cursor without firing via the %s store path", async (_path, createStore) => {
    const store = createStore();
    const engine = createAutomations({ tools: registry(), guard: new GuardDouble(), store, now: () => NOW });
    await create(engine, { id: "atm_schedule_future", when: { at: "2026-07-12T13:00:00.000Z" }, task: noop });
    await store.records("automations:schedule").delete("atm_schedule_future");

    await expect(engine.tick()).resolves.toEqual([]);
    expect((await store.records("automations:schedule").get("atm_schedule_future"))?.data).toEqual({
      lastFiredAt: NOW.toISOString(),
    });
  });

  it("fires an automation ONCE for two ticks at the same instant — the cursor claim is atomic", async () => {
    const store = memoryStoreAdapter();
    let calls = 0;
    const tools = registry([readTool], async () => {
      calls += 1;
      return { status: "ok", output: {} };
    });
    const engine = createAutomations({ tools, guard: new GuardDouble(), store, now: () => NOW });
    const peer = createAutomations({ tools, guard: new GuardDouble(), store, now: () => NOW });
    await create(engine, {
      id: "atm_schedule_first_claim",
      when: { at: "2026-07-12T11:00:00.000Z" },
      task: { kind: "steps", steps: [{ id: "run", tool: readTool.name }] },
    });
    await store.records("automations:schedule").delete("atm_schedule_first_claim");

    const ticks = await Promise.all([engine.tick(), peer.tick()]);

    expect(ticks.flat()).toHaveLength(1);
    expect(calls).toBe(1);
    expect((await store.records("automations:schedule").get("atm_schedule_first_claim"))?.data).toEqual({
      lastFiredAt: NOW.toISOString(),
      firedAt: NOW.toISOString(),
    });
  });

  it("verifies HMAC vectors per record, dedupes deliveries, rejects bad/stale signatures once, and emits matching host events", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const observed: Json[] = [];
    const tools = registry([readTool], async (call) => {
      observed.push(call.args);
      return { status: "ok", output: {} };
    });
    const engine = createAutomations({ tools, guard, store, now: () => NOW });
    const peer = createAutomations({ tools, guard: new GuardDouble(), store, now: () => NOW });
    const handle = { kind: "steps" as const, steps: [{ id: "handle", tool: readTool.name, args: { payload: "event" } }] };
    const external = await create(engine, { id: "atm_webhook", when: { webhook: "github" }, task: handle });
    await create(engine, { id: "atm_host", when: { event: "invoice.paid" }, task: handle });
    const secret = external.webhookSecret!;
    const body = JSON.stringify({ answer: 42 });
    const timestamp = String(NOW.getTime() / 1_000);
    const signature = await sign(secret, "delivery_1", timestamp, body);
    const request = (sig: string, at = timestamp, delivery = "delivery_1", requestBody = body) => new Request("https://example.test/api/webhooks/github", {
      method: "POST",
      headers: {
        "webhook-id": delivery,
        "webhook-timestamp": at,
        "webhook-signature": `v1,${sig}`,
      },
      body: requestBody,
    });

    const valid = await engine.webhook(request(signature));
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ runIds: [expect.stringMatching(/^run_/)] });
    const duplicate = await engine.webhook(request(signature));
    expect(await duplicate.json()).toEqual({ deduped: true });
    const bad = await engine.webhook(request("AAAA", timestamp, "delivery_bad"));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: { code: "blocked", message: "webhook signature verification failed" } });
    const staleTimestamp = String(NOW.getTime() / 1_000 - 301);
    const stale = await engine.webhook(request(await sign(secret, "delivery_stale", staleTimestamp, body), staleTimestamp, "delivery_stale"));
    expect(stale.status).toBe(401);
    const invalidJson = "{not-json";
    const unverifiedInvalid = await engine.webhook(request("AAAA", timestamp, "delivery_invalid_bad", invalidJson));
    expect(unverifiedInvalid.status).toBe(401);
    const verifiedInvalid = await engine.webhook(request(
      await sign(secret, "delivery_invalid_ok", timestamp, invalidJson),
      timestamp,
      "delivery_invalid_ok",
      invalidJson,
    ));
    expect(verifiedInvalid.status).toBe(400);
    const auditsBeforeSize = guard.audit.length;
    const oversized = await engine.webhook(request(
      "AAAA",
      timestamp,
      "delivery_oversized",
      "x".repeat(1024 * 1024 + 1),
    ));
    expect(oversized.status).toBe(413);
    // Oversized rejections audit like every other unverified-input rejection.
    expect(guard.audit).toHaveLength(auditsBeforeSize + 1);
    expect(guard.audit.filter((event) => (event.detail as { status?: string }).status === "webhook-rejected")).toHaveLength(4);

    const concurrentBody = JSON.stringify({ concurrent: true });
    const concurrentSignature = await sign(secret, "delivery_concurrent", timestamp, concurrentBody);
    const concurrent = await Promise.all([
      engine.webhook(request(concurrentSignature, timestamp, "delivery_concurrent", concurrentBody)),
      peer.webhook(request(concurrentSignature, timestamp, "delivery_concurrent", concurrentBody)),
    ]);
    expect(concurrent.map(({ status }) => status)).toEqual([200, 200]);
    expect((await store.records("vendo_runs").list()).records).toHaveLength(2);

    expect(await engine.emit("invoice.paid", { invoice: "inv_1" }, ctx().principal)).toHaveLength(1);
    expect(await engine.emit("invoice.paid", {}, ctx("other").principal)).toEqual([]);
    expect(observed).toContainEqual({ payload: { answer: 42 } });
    expect(observed).toContainEqual({ payload: { invoice: "inv_1" } });
  });

  it("dedupes webhook deliveries when the store lacks atomic claims", async () => {
    const store = memoryStoreWithoutAtomic();
    const engine = createAutomations({ tools: registry(), guard: new GuardDouble(), store, now: () => NOW });
    const external = await create(engine, { id: "atm_webhook_fallback", when: { webhook: "github" }, task: noop });
    const body = JSON.stringify({ answer: 42 });
    const timestamp = String(NOW.getTime() / 1_000);
    const deliveryId = "delivery_fallback";
    const signature = await sign(external.webhookSecret!, deliveryId, timestamp, body);
    const request = () => new Request("https://example.test/api/webhooks/github", {
      method: "POST",
      headers: {
        "webhook-id": deliveryId,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      },
      body,
    });

    const first = await engine.webhook(request());
    const duplicate = await engine.webhook(request());

    expect(await first.json()).toMatchObject({ runIds: [expect.stringMatching(/^run_/)] });
    expect(await duplicate.json()).toEqual({ deduped: true });
    expect((await store.records("vendo_runs").list()).records).toHaveLength(1);
    expect((await store.records("automations:deliveries").get(`${external.id}:${deliveryId}`))?.data).toEqual({
      automationId: external.id,
      deliveryId,
      receivedAt: NOW.toISOString(),
    });
  });

  it("refs every generic row it writes to its automation, so an automation erase collects them", async () => {
    const store = memoryStoreAdapter();
    const engine = createAutomations({ tools: registry(), guard: new GuardDouble(), store, now: () => NOW });
    const external = await create(engine, { id: "atm_refs_webhook", when: { webhook: "github" }, task: noop });
    // No cursor row yet for these two: the TICK is what writes both — the
    // claiming path and the not-yet-due path — and an unref'd row outlives the
    // record forever.
    await create(engine, { id: "atm_refs_tick_due", when: { every: "15m" }, task: noop });
    await create(engine, { id: "atm_refs_tick_future", when: { at: "2026-07-12T13:00:00.000Z" }, task: noop });
    for (const id of ["atm_refs_tick_due", "atm_refs_tick_future"]) {
      await store.records("automations:schedule").delete(id);
    }
    const body = JSON.stringify({ answer: 42 });
    const timestamp = String(NOW.getTime() / 1_000);
    await engine.webhook(new Request("https://example.test/api/webhooks/github", {
      method: "POST",
      headers: {
        "webhook-id": "delivery_refs",
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${await sign(external.webhookSecret!, "delivery_refs", timestamp, body)}`,
      },
      body,
    }));
    await engine.tick();

    expect((await store.records("automations:deliveries").get(`${external.id}:delivery_refs`))?.refs)
      .toEqual({ automation_id: external.id });
    expect((await store.records("automations:schedule").get("atm_refs_tick_due"))?.refs)
      .toEqual({ automation_id: "atm_refs_tick_due" });
    expect((await store.records("automations:schedule").get("atm_refs_tick_future"))?.refs)
      .toEqual({ automation_id: "atm_refs_tick_future" });
  });
});

describe("dry runs, run visibility, goal execution, and stopping", () => {
  it("previews concrete steps without persistence and reports critical asks separately from missing grants", async () => {
    const store = memoryStoreAdapter();
    const engine = createAutomations({
      tools: registry([readTool, criticalTool]), guard: new GuardDouble(), store, now: () => NOW,
    });
    const record = await create(engine, {
      id: "atm_preview",
      when: { event: "go" },
      task: { kind: "steps", steps: [
        { id: "fan", tool: readTool.name, forEach: "event.items" },
        { id: "critical", tool: criticalTool.name },
      ] },
    });
    const beforeApprovals = await store.records("vendo_approvals").list();

    const plan = await engine.dryRun(record.id, ctx(), { items: [1, 2] });

    expect(plan.steps).toEqual([
      { id: "fan", tool: readTool.name, wouldAsk: true },
      { id: "fan", tool: readTool.name, wouldAsk: true },
      { id: "critical", tool: criticalTool.name, wouldAsk: true },
    ]);
    expect(plan.grantsMissing).toEqual([readTool.name]);
    expect(await store.records("vendo_approvals").list()).toEqual(beforeApprovals);
    expect((await store.records("automations:captures").list()).records).toHaveLength(0);
  });

  /** `dryRun` is public surface, and a manifest automation's only step is an app
   *  function — so a preview of one has to ANSWER. An `fn:` ref is the app's own
   *  server code, so it is listed (a preview says what would run) but never
   *  resolved against the host registry and never a missing grant. */
  it("previews an app-function step instead of resolving it against the host registry", async () => {
    const store = memoryStoreAdapter();
    const engine = createAutomations({
      tools: registry([readTool]), guard: new GuardDouble(), store, now: () => NOW,
    });
    const record = await create(engine, {
      id: "atm_dryrun_fn",
      authoredBy: "manifest",
      when: "0 8 * * *",
      task: { kind: "steps", steps: [
        { id: "fire", tool: "fn:chaseInvoices" },
        { id: "read", tool: readTool.name },
      ] },
    });

    const plan = await engine.dryRun(record.id, ctx());

    expect(plan.steps).toEqual([
      { id: "fire", tool: "fn:chaseInvoices", wouldAsk: false },
      { id: "read", tool: readTool.name, wouldAsk: true },
    ]);
    expect(plan.grantsMissing).toEqual([readTool.name]);
  });

  /** The loud path the case above must not soften: a step naming a HOST tool this
   *  deployment does not offer is a broken automation, and the preview says so
   *  rather than quietly dropping the step. */
  it("still refuses a preview whose step names a host tool the registry has never heard of", async () => {
    const store = memoryStoreAdapter();
    const engine = createAutomations({
      tools: registry([readTool]), guard: new GuardDouble(), store, now: () => NOW,
    });
    const record = await create(engine, {
      id: "atm_dryrun_typo",
      when: "0 8 * * *",
      task: { kind: "steps", steps: [{ id: "read", tool: "host_invoices_lst" }] },
    });

    await expect(engine.dryRun(record.id, ctx())).rejects.toThrow(/unknown tool in automation: host_invoices_lst/);
  });

  it("surfaces a scheduler-refused run (pricing v3 §5) as a failed run carrying the blocked reason", async () => {
    // Under a hosted store, Cloud's scheduler is the firing authority for
    // schedule/external automations and writes run rows with the same shape
    // this engine writes (writeRun). A run it refused at the meter gate must
    // read back as a plain failed run — the refusal's own reason and code
    // intact — wherever OSS renders run status. No client-side checks: the
    // record is the truth.
    const store = memoryStoreAdapter();
    const engine = createAutomations({ tools: registry([readTool]), guard: new GuardDouble(), store, now: () => NOW });
    const automation = await create(engine, {
      id: "atm_blocked",
      when: { event: "go" },
      task: { kind: "steps", steps: [{ id: "read", tool: readTool.name }] },
    });
    const blockedReason =
      "blocked by allowance: Vendo Cloud paused automation runs — the allowance for this billing "
      + "period is used up (1,050 of 1,000 used; resets 2026-08-01). "
      + "Upgrade your plan (https://console.vendo.run/billing) "
      + "or bring your own infrastructure (https://docs.vendo.run/byo).";
    const record = {
      id: "run_blocked",
      automationId: automation.id,
      owner: automation.owner,
      trigger: { kind: "schedule" as const },
      status: "error" as const,
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      steps: [],
      summary: "blocked by allowance",
      error: { code: "meter-exhausted", message: blockedReason },
    };
    await store.records("vendo_runs").put({
      id: record.id,
      data: {
        automationId: record.automationId,
        trigger: record.trigger,
        status: record.status,
        record,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
      },
    });

    expect(await engine.runs.get("run_blocked", ctx())).toMatchObject({
      status: "error",
      error: { code: "meter-exhausted", message: blockedReason },
    });
    const listed = await engine.runs.list({ automationId: automation.id, status: "error" }, ctx());
    expect(listed.runs).toMatchObject([{ id: "run_blocked", error: { code: "meter-exhausted" } }]);
    // Still owner-scoped like any other run.
    expect(await engine.runs.get("run_blocked", ctx("other"))).toBeNull();
  });

  it("runs goal work with default budget 50 and scopes the run ledger to whoever holds the automation", async () => {
    const store = memoryStoreAdapter();
    const budgets: Array<number | undefined> = [];
    const engine = createAutomations({
      tools: registry([readTool]), guard: new GuardDouble(), store, now: () => NOW,
    });
    register(engine, async (task) => {
      budgets.push(task.budget?.maxToolCalls);
      return {
        status: "ok",
        summary: "agent finished",
        toolCalls: [{ call: { id: "call_agent", tool: readTool.name, args: {} }, outcome: "ok" }],
      };
    });
    const record = await create(engine, { id: "atm_goal_run", when: { event: "go" }, task: { kind: "goal", prompt: "work" } });

    const [runId] = await engine.emit("go", {}, ctx().principal);

    expect(budgets).toEqual([50]);
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "ok",
      summary: "agent finished",
      steps: [{ id: "call_agent", tool: readTool.name, outcome: "ok", at: NOW.toISOString() }],
    });
    expect(await engine.runs.get(runId!, ctx("other"))).toBeNull();
    expect((await engine.runs.list({}, ctx("other"))).runs).toEqual([]);
    expect((await engine.runs.list({ automationId: record.id, status: "ok" }, ctx())).runs).toHaveLength(1);
  });

  /** 07 §5 — the owner and agent views are FILTERS over the one ledger. Both are
   *  declared on the public surface and both are mapped from a query param on the
   *  public `/runs` route, so a filter the store cannot answer is a 500 on a
   *  documented door rather than a result. */
  it("filters the one ledger by owner and by agent", async () => {
    const store = memoryStoreAdapter();
    const engine = createAutomations({
      tools: registry([readTool]),
      guard: new GuardDouble(),
      store,
      now: () => NOW,
      memberships: async () => [{ org: "org_acme" }],
    });
    register(engine, async () => ({ status: "ok", summary: "mine", toolCalls: [] }));
    register(engine, async () => ({ status: "ok", summary: "theirs", toolCalls: [] }), "nightly");
    // §9.1 — the org is ASSERTED for this caller, so it speaks for both subjects
    // and both records' runs are its to read.
    const member: RunContext = { ...ctx(), memberships: [{ org: "org_acme" }] };
    const mine = await create(engine, {
      id: "atm_ledger_mine",
      when: { event: "go" },
      task: { kind: "goal", prompt: "mine" },
    }, member);
    const theirs = await create(engine, {
      id: "atm_ledger_org",
      owner: { kind: "user", subject: "org_acme" },
      when: { event: "go" },
      task: { kind: "goal", prompt: "theirs" },
      agent: "nightly",
    }, member);

    await engine.emit("go", {}, member.principal);

    expect((await engine.runs.list({}, member)).runs).toHaveLength(2);
    expect((await engine.runs.list({ owner: "org_acme" }, member)).runs)
      .toMatchObject([{ automationId: theirs.id }]);
    expect((await engine.runs.list({ owner: "user_a" }, member)).runs)
      .toMatchObject([{ automationId: mine.id }]);
    expect((await engine.runs.list({ agent: "nightly" }, member)).runs)
      .toMatchObject([{ automationId: theirs.id }]);
  });

  it("marks an in-flight goal run stopped, discards the late result, and rejects terminal stops", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let receivedSignal: AbortSignal | undefined;
    const engine = createAutomations({ tools: registry(), guard, store, now: () => NOW });
    register(engine, async (task) => {
      receivedSignal = task.abortSignal;
      started();
      return await new Promise((resolve) => {
        task.abortSignal?.addEventListener("abort", () => resolve({
          status: "stopped", summary: "aborted", toolCalls: [],
        }), { once: true });
      });
    });
    await create(engine, { id: "atm_stop", when: { event: "go" }, task: { kind: "goal", prompt: "wait" } });
    const emitted = engine.emit("go", {}, ctx().principal);
    await didStart;
    const running = (await engine.runs.list({ status: "running" }, ctx())).runs[0]!;

    await engine.runs.stop(running.id, ctx());
    await emitted;

    expect(receivedSignal?.aborted).toBe(true);
    expect(await engine.runs.get(running.id, ctx())).toMatchObject({
      status: "stopped", summary: "stopped by user", finishedAt: NOW.toISOString(),
    });
    await expect(engine.runs.stop(running.id, ctx())).rejects.toMatchObject({ code: "conflict" });
    expect(guard.audit.map((event) => (event.detail as { status: string }).status)).toEqual(["running", "stopped"]);
  });

  it("start survives a failing tick without an unhandled rejection", async () => {
    vi.useFakeTimers();
    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => { rejections.push(reason); };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const base = memoryStoreAdapter();
      // A store hiccup (or a corrupt row) makes every runTick reject.
      const store: StoreAdapter = {
        ensureSchema: () => base.ensureSchema(),
        blobs: (namespace) => base.blobs(namespace),
        records: (collection) => ({
          ...base.records(collection),
          list: async () => { throw new Error("store unavailable"); },
        }),
      };
      const engine = createAutomations({ tools: registry(), guard: new GuardDouble(), store, now: () => NOW });
      const stop = engine.start(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      stop();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      vi.useRealTimers();
    }
  });

  it("start skips overlapping ticks and returned stop functions are independent", async () => {
    vi.useFakeTimers();
    try {
      const store = memoryStoreAdapter();
      const engine = createAutomations({ tools: registry(), guard: new GuardDouble(), store, now: () => NOW });
      const stopA = engine.start(1_000);
      const stopB = engine.start(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      stopA();
      stopB();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
