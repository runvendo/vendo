import {
  type ApprovalId,
  type AuditEvent,
  type AutomationRecord,
  type CreateAutomationInput,
  type Guard,
  type Principal,
  type RunContext,
  type StoreAdapter,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { beforeEach, describe, expect, it } from "vitest";
import {
  automationsInternals,
  createAutomations,
  type AutomationsConfig,
  type AutomationsEngine,
} from "../src/index.js";
import { currentIntentHash, SPONSORED, SPONSORSHIPS, type Sponsorship } from "../src/sponsorship.js";

/** Contract §9.9 — sponsorship: an automation always runs as a named person.
 *  Every gate below is a red-green pair: the same fire is shown RUNNING while
 *  the sponsorship holds and STOPPING once it does not, so a gate that stopped
 *  gating would fail here instead of passing quietly.
 *
 *  Sponsorship is keyed to the RECORD now. There is no app, so there is no
 *  app-access seam and no `grants` lapse reason: the two ways a sponsorship ends
 *  are the record's intent CHANGING under it (`edit`) and the sponsor's row being
 *  ERASED (`departure`). */

const NOW = new Date("2026-08-01T09:00:00.000Z");

const readTool: ToolDescriptor = {
  name: "host_readAccounts",
  description: "Read the accounts",
  inputSchema: { type: "object" },
  risk: "read",
};

const writeTool: ToolDescriptor = {
  name: "host_updateInvoice",
  description: "Update an invoice",
  inputSchema: { type: "object" },
  risk: "write",
};

const ctx = (subject = "user_dana", display?: string): RunContext => ({
  principal: { kind: "user", subject, ...(display === undefined ? {} : { display }) },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

/** §9.1's memberships are ASSERTED on the ctx, never stored — a passthrough
 *  field, so it is attached the same way the wire attaches it. */
const withOrg = (subject: string, display?: string, org = "maple"): RunContext =>
  ({ ...ctx(subject, display), memberships: [{ org }] }) as RunContext;

/** The two-step task every gate below fires: enough steps that a stopped run is
 *  visibly a run that called NOTHING. */
const steps = (invoice = "inv_42"): CreateAutomationInput["task"] => ({
  kind: "steps",
  steps: [
    { id: "read", tool: readTool.name },
    { id: "write", tool: writeTool.name, args: { invoice: `'${invoice}'` } },
  ],
});

class GuardDouble implements Guard {
  readonly audit: AuditEvent[] = [];
  private readonly callbacks = new Set<(id: ApprovalId, approved: boolean) => void>();

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

const flush = async (): Promise<void> => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); };

interface Harness {
  store: StoreAdapter;
  guard: GuardDouble;
  engine: AutomationsEngine;
  calls: Array<{ call: ToolCall; ctx: RunContext }>;
}

const harness = (
  overrides: Partial<AutomationsConfig> = {},
  /** Scripted outcomes per execution, so a test can park a call. */
  plan: (call: ToolCall, index: number) => ToolOutcome | undefined = () => undefined,
): Harness => {
  const store = overrides.store ?? memoryStoreAdapter();
  const guard = new GuardDouble();
  const calls: Array<{ call: ToolCall; ctx: RunContext }> = [];
  const tools: ToolRegistry = {
    async descriptors() { return [readTool, writeTool]; },
    async execute(call, runCtx): Promise<ToolOutcome> {
      const index = calls.length;
      calls.push({ call: structuredClone(call), ctx: structuredClone(runCtx) });
      return plan(call, index) ?? { status: "ok", output: {} };
    },
  };
  const engine = createAutomations({ tools, guard, store, now: () => NOW, ...overrides });
  return { store, guard, engine, calls };
};

/** The ONE create op — there is no public create, so every authoring door goes
 *  through `automationsInternals` and the tests do too. An explicit `id` is what
 *  makes a later create a REPLACE of the same identity, which is how an edit is
 *  expressed on a record. */
const create = async (
  engine: AutomationsEngine,
  input: Omit<CreateAutomationInput, "owner" | "authoredBy"> & Partial<CreateAutomationInput>,
  runCtx: RunContext = ctx(),
): Promise<AutomationRecord> =>
  await automationsInternals(engine).create(
    { owner: runCtx.principal, authoredBy: "chat", ...input },
    runCtx,
  );

const sponsorshipRow = async (store: StoreAdapter, automationId: string): Promise<Sponsorship | undefined> =>
  (await store.records(SPONSORSHIPS).get(automationId))?.data as Sponsorship | undefined;

const setSponsorship = async (store: StoreAdapter, row: Sponsorship): Promise<void> => {
  await store.records(SPONSORSHIPS).put({
    id: row.automationId,
    data: row,
    refs: { subject: row.sponsor, automation_id: row.automationId },
  });
};

describe("sponsorship — minted at enable", () => {
  let store: StoreAdapter;

  beforeEach(() => { store = memoryStoreAdapter(); });

  it("mints an active sponsorship over the record's intent when the owner enables it", async () => {
    const { engine } = harness({ store });
    const record = await create(engine, {
      id: "atm_mint", when: { event: "go" }, task: steps(), armed: false,
    });

    expect(await sponsorshipRow(store, record.id)).toBeUndefined();
    await engine.enable(record.id, ctx());

    expect(await sponsorshipRow(store, record.id)).toMatchObject({
      automationId: record.id,
      sponsor: "user_dana",
      status: "active",
      intentHash: currentIntentHash(record),
    });
  });

  it("refs the row to both erase axes, so no dangling name survives either cascade", async () => {
    const { engine } = harness({ store });
    await create(engine, { id: "atm_erasable", when: { event: "go" }, task: steps(), armed: false });

    await engine.enable("atm_erasable", ctx());

    expect((await store.records(SPONSORSHIPS).get("atm_erasable"))?.refs)
      .toEqual({ subject: "user_dana", automation_id: "atm_erasable" });
  });

  it("re-enabling after an invalidation refreshes the row to the enabler", async () => {
    const { engine } = harness({ store });
    const record = await create(engine, {
      id: "atm_remint", when: { event: "go" }, task: steps(), armed: false,
    });
    await setSponsorship(store, {
      automationId: record.id, sponsor: "user_gone", intentHash: "sha256:stale",
      status: "invalidated", reason: "departure", invalidatedAt: NOW.toISOString(),
    });

    await engine.enable(record.id, ctx());

    expect(await sponsorshipRow(store, record.id)).toMatchObject({
      sponsor: "user_dana", status: "active", intentHash: currentIntentHash(record),
    });
    expect(await sponsorshipRow(store, record.id)).not.toHaveProperty("reason");
  });
});

describe("sponsorship — the fire-time gate", () => {
  it("runs as the sponsor while the sponsorship holds, and stops loudly once it does not", async () => {
    // RED half: an active, matching sponsorship fires and calls the tools.
    const green = harness();
    await create(green.engine, { id: "atm_gate", when: { event: "go" }, task: steps() });
    await green.engine.enable("atm_gate", ctx());
    await green.engine.emit("go", {}, ctx().principal);
    expect(green.calls.map(({ call }) => call.tool)).toEqual([readTool.name, writeTool.name]);
    expect(green.calls[0]?.ctx.principal.subject).toBe("user_dana");

    // GREEN half: the record's task is replaced under the same identity, so the
    // intent the sponsor consented to is no longer what it does — and the very
    // same fire stops before any tool call at all.
    const stopped = harness();
    await create(stopped.engine, { id: "atm_gate", when: { event: "go" }, task: steps() });
    await stopped.engine.enable("atm_gate", ctx());
    await create(stopped.engine, { id: "atm_gate", when: { event: "go" }, task: steps("inv_EVIL") });
    const runIds = await stopped.engine.emit("go", {}, ctx().principal);

    expect(stopped.calls).toEqual([]);
    const run = await stopped.engine.runs.get(runIds[0]!, ctx());
    expect(run?.status).toBe("error");
    expect(run?.summary).toMatch(/stopped/i);
    expect(stopped.guard.audit.some((event) =>
      (event.detail as { status?: string }).status === "sponsorship-invalidated")).toBe(true);
  });

  it("stops when the stored intent no longer matches the live record", async () => {
    const { store, engine, calls } = harness();
    await create(engine, { id: "atm_drifted", when: { event: "go" }, task: steps() });
    await engine.enable("atm_drifted", ctx());
    // An edit that never went through `enable` — a redeploy replacing the task,
    // or a direct row write — must still fail closed at fire time.
    await create(engine, { id: "atm_drifted", when: { event: "go" }, task: steps("inv_99") });

    await engine.emit("go", {}, ctx().principal);

    expect(calls).toEqual([]);
    expect(await sponsorshipRow(store, "atm_drifted")).toMatchObject({ status: "invalidated", reason: "edit" });
  });

  it("re-binds the intent when the sponsor re-enables it, so their own edit does not strand it", async () => {
    const { store, engine, calls } = harness();
    await create(engine, { id: "atm_rebound", when: { event: "go" }, task: steps() });
    await engine.enable("atm_rebound", ctx());
    const edited = await create(engine, { id: "atm_rebound", when: { event: "go" }, task: steps("inv_77") });

    await engine.enable("atm_rebound", ctx());
    await engine.emit("go", {}, ctx().principal);

    expect(await sponsorshipRow(store, "atm_rebound")).toMatchObject({
      status: "active", sponsor: "user_dana", intentHash: currentIntentHash(edited),
    });
    expect(calls.map(({ call }) => call.tool)).toEqual([readTool.name, writeTool.name]);
    expect(calls[1]?.call.args).toEqual({ invoice: "inv_77" });
  });

  it("leaves an already-invalidated row alone rather than restamping it", async () => {
    const { store, engine } = harness();
    await create(engine, { id: "atm_idempotent", when: { event: "go" }, task: steps() });
    await engine.enable("atm_idempotent", ctx());
    await create(engine, { id: "atm_idempotent", when: { event: "go" }, task: steps("inv_1") });
    await engine.emit("go", {}, ctx().principal);
    const first = await sponsorshipRow(store, "atm_idempotent");
    expect(first).toMatchObject({ status: "invalidated", reason: "edit" });

    await engine.emit("go", {}, ctx().principal);

    expect(await sponsorshipRow(store, "atm_idempotent")).toEqual(first);
  });

  it("resolves memberships for the fire and rides them onto the run context", async () => {
    const { engine, calls } = harness({ memberships: async () => [{ org: "maple", admin: false }] });
    await create(engine, { id: "atm_memberships", when: { event: "go" }, task: steps() });
    await engine.enable("atm_memberships", ctx());

    await engine.emit("go", {}, ctx().principal);

    // The unattended fire is the reason the memberships seam is keyed on
    // Principal at all: there is no session behind it to resolve them from.
    expect(calls[0]?.ctx).toMatchObject({
      principal: { subject: "user_dana" },
      presence: "away",
      memberships: [{ org: "maple" }],
    });
  });
});

/** A run that met a missing permission fails loudly, and the remedy is a FRESH
 *  run through `runs.rerun`. That is a second firing through a different door, so
 *  the fire-time gate has to run again there too: an edit between the failure and
 *  the re-run must never get the sponsor's identity to execute the edited call. */
describe("sponsorship — the re-run gate", () => {
  const missOnce = (store: StoreAdapter) => (call: ToolCall, index: number): ToolOutcome | undefined => {
    if (index !== 0) return undefined;
    void store.records("vendo_approvals").put({
      id: "apr_parked",
      data: {
        request: {
          id: "apr_parked",
          call: structuredClone(call),
          descriptor: writeTool,
          inputPreview: "update the invoice",
          ctx: { principal: { kind: "user", subject: "user_dana" }, venue: "automation", presence: "away" },
          createdAt: NOW.toISOString(),
        },
        status: "pending",
      },
    });
    return { status: "pending-approval", approvalId: "apr_parked" };
  };

  const oneWriteStep = (invoice: string): CreateAutomationInput["task"] =>
    ({ kind: "steps", steps: [{ id: "write", tool: writeTool.name, args: { invoice: `'${invoice}'` } }] });

  /** The ask a PERSON answers for this tool: the outstanding capture the panel
   *  renders. (The guard also raises its own away row at the miss; when an arming
   *  ask for the same permission is still open, that one is the live question and
   *  the engine captures no second one.) */
  const liveAsk = async (store: StoreAdapter): Promise<string> => {
    const captures = await store.records("automations:captures").list();
    const ask = captures.records.find((record) => (record.data as { tool: string }).tool === writeTool.name);
    if (ask === undefined) throw new Error("no outstanding ask for the write tool");
    return ask.id;
  };

  it("re-runs the whole automation as its sponsor once the permission is granted", async () => {
    const store = memoryStoreAdapter();
    const { engine, guard, calls } = harness({ store }, missOnce(store));
    await create(engine, { id: "atm_rerun_ok", when: { event: "go" }, task: oneWriteStep("inv_42") });
    await engine.enable("atm_rerun_ok", ctx());
    const [runId] = await engine.emit("go", {}, ctx().principal);
    // The miss is LOUD and terminal — nothing waits on the decision.
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "needs-permission", tool: writeTool.name },
    });

    guard.decide(await liveAsk(store), true);
    await flush();
    // The decision alone runs nothing: the failed run stays failed.
    expect(calls).toHaveLength(1);
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({ status: "error" });

    const rerunId = await engine.runs.rerun(runId!, ctx());

    expect(calls).toHaveLength(2);
    expect(calls[1]?.call.args).toEqual({ invoice: "inv_42" });
    expect(calls[1]?.ctx.principal.subject).toBe("user_dana");
    expect(await engine.runs.get(rerunId, ctx())).toMatchObject({ status: "ok" });
  });

  /** The fresh run is fired under the CURRENT sponsorship, which is what makes a
   *  hand-over between the failure and the re-run safe: it runs as whoever holds
   *  the automation now, and the previous sponsor's ask grants them nothing. */
  it("re-runs as the new sponsor after the automation changes hands, granting the old one nothing", async () => {
    const store = memoryStoreAdapter();
    // An ORG-owned record only fires through the memberships seam: no principal is
    // ever an org, so `emit` reaches it via the orgs the emitter asserts.
    const { engine, guard, calls } = harness(
      { store, memberships: async () => [{ org: "maple" }] },
      missOnce(store),
    );
    // ORG-owned, so two different people can each speak for it and the sponsor is
    // never simply the owner.
    const owner: Principal = { kind: "org", subject: "maple" };
    await create(
      engine,
      { id: "atm_rerun_rearmed", owner, when: { event: "go" }, task: oneWriteStep("inv_42") },
      withOrg("user_dana", "Dana"),
    );
    await engine.enable("atm_rerun_rearmed", withOrg("user_dana", "Dana"));
    const [runId] = await engine.emit("go", {}, withOrg("user_dana").principal);
    expect(await engine.runs.get(runId!, withOrg("user_dana"))).toMatchObject({ status: "error" });

    // Dana's outstanding ask, before anything changes hands.
    const danasAsk = await liveAsk(store);
    // A different member re-arms it, so it now runs as Omar.
    expect((await engine.enable("atm_rerun_rearmed", withOrg("user_omar", "Omar"))).enabled).toBe(true);

    guard.decide(danasAsk, true);
    await flush();
    // Dana's ask minted Dana's grant, not Omar's…
    expect((await store.records("vendo_grants").list()).records.map((record) =>
      (record.data as { subject: string }).subject)).toEqual(["user_dana"]);

    const rerunId = await engine.runs.rerun(runId!, withOrg("user_omar", "Omar"));

    // …and the fresh run acts as OMAR, so it is HIS authority the guard weighs,
    // never the identity of the person who was asked before he took it on.
    expect(calls[1]?.ctx.principal.subject).toBe("user_omar");
    expect(await engine.runs.get(rerunId, withOrg("user_omar"))).toMatchObject({
      automationId: "atm_rerun_rearmed",
    });
  });

  /** An edit landing between the failure and the re-run must never get the
   *  sponsor's identity to execute the EDITED call. On a record that protection is
   *  structural rather than a refusal: the re-run fires the frozen snapshot of the
   *  record that fired, so the edited step list is never read at all. */
  it("re-runs the consented call, never the one an edit substituted for it", async () => {
    const store = memoryStoreAdapter();
    const { engine, guard, calls } = harness({ store }, missOnce(store));
    await create(engine, { id: "atm_rerun_evil", when: { event: "go" }, task: oneWriteStep("inv_42") });
    await engine.enable("atm_rerun_evil", ctx());
    const [runId] = await engine.emit("go", {}, ctx().principal);

    // Somebody rewrites the automation between the failure and the re-run.
    await create(engine, { id: "atm_rerun_evil", when: { event: "go" }, task: oneWriteStep("inv_EVIL") });

    guard.decide("apr_parked", true);
    await flush();
    const rerunId = await engine.runs.rerun(runId!, ctx());

    // The substituted invoice never runs, under any identity.
    expect(calls.map(({ call }) => call.args)).toEqual([{ invoice: "inv_42" }, { invoice: "inv_42" }]);
    expect(JSON.stringify(calls)).not.toContain("inv_EVIL");
    expect(await engine.runs.get(rerunId, ctx())).toMatchObject({ status: "ok" });

    // ...and the NEXT ordinary firing does stop, because the live record no longer
    // matches what its sponsor allowed.
    const [nextId] = await engine.emit("go", {}, ctx().principal);
    expect(calls).toHaveLength(2);
    expect((await engine.runs.get(nextId!, ctx()))?.summary).toMatch(/stopped/i);
    expect(guard.audit.some((event) =>
      (event.detail as { status?: string }).status === "sponsorship-invalidated")).toBe(true);
  });
});

/** The sponsorship row carries the sponsor's subject, so a subject erase DELETES
 *  it. Without a trace that the record was ever sponsored, the fire-time gate
 *  would read "no sponsorship" and quietly hand the automation back to its owner.
 *  The era marker is that trace: keyed to the record only, so a subject erase
 *  cannot collect it and an automation erase can. */
describe("sponsorship — an erased sponsor", () => {
  /** What `eraseStore.bySubject` does to the row: it matches generic records on
   *  `refs @> {subject}`. The row's refs are asserted separately. */
  const eraseSponsorRow = async (store: StoreAdapter, automationId: string): Promise<void> => {
    await store.records(SPONSORSHIPS).delete(automationId);
  };

  it("carries no subject data on the era marker, so a subject erase cannot collect it", async () => {
    const { store, engine } = harness();
    await create(engine, { id: "atm_era", when: { event: "go" }, task: steps() });
    await engine.enable("atm_era", ctx());

    const marker = await store.records(SPONSORED).get("atm_era");
    expect(marker?.refs).toEqual({ automation_id: "atm_era" });
    expect(JSON.stringify(marker?.data)).not.toContain("user_dana");
  });

  it("stops the automation instead of reverting to the owner", async () => {
    const { store, engine, calls } = harness({ memberships: async () => [{ org: "maple" }] });
    const owner: Principal = { kind: "org", subject: "maple" };
    await create(
      engine,
      { id: "atm_erased_sponsor", owner, when: { event: "go" }, task: steps() },
      withOrg("user_dana", "Dana"),
    );
    await engine.enable("atm_erased_sponsor", withOrg("user_dana", "Dana"));
    await eraseSponsorRow(store, "atm_erased_sponsor");

    const runIds = await engine.emit("go", {}, withOrg("user_dana").principal);

    // It did NOT run — not as the owner, not as anybody.
    expect(calls).toEqual([]);
    const run = await engine.runs.get(runIds[0]!, withOrg("user_omar"));
    expect(run?.summary).toMatch(/no longer has access to it/);
    // ...and the erased subject does not come back through the list either.
    expect(JSON.stringify(await engine.list({}, withOrg("user_omar")))).not.toContain("user_dana");
  });

  it("still lets a pre-sponsorship automation (no marker at all) run as its owner", async () => {
    const { store, engine, calls } = harness();
    await create(engine, { id: "atm_legacy", when: { event: "go" }, task: steps() });
    await engine.enable("atm_legacy", ctx());
    await eraseSponsorRow(store, "atm_legacy");
    await store.records(SPONSORED).delete("atm_legacy");

    await engine.emit("go", {}, ctx().principal);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.ctx.principal.subject).toBe("user_dana");
  });
});

/** Nothing a person reads should say `user_dana`. The sponsor's own display name
 *  is captured at enable (their Principal carries it) and used everywhere the
 *  automation talks about them. */
describe("sponsorship — consumer-voice names", () => {
  it("captures the sponsor's display name, and keeps it off the run summary", async () => {
    // The NAME stays off the persisted run summary: the run row outlives a
    // subject erase, the sponsorship row does not.
    const { store, engine } = harness();
    await create(engine, { id: "atm_named", when: { event: "go" }, task: steps() });
    await engine.enable("atm_named", ctx("user_dana", "Dana"));
    expect(await sponsorshipRow(store, "atm_named")).toMatchObject({ display: "Dana" });

    await create(engine, { id: "atm_named", when: { event: "go" }, task: steps("inv_2") });
    const runIds = await engine.emit("go", {}, ctx().principal);
    const run = await engine.runs.get(runIds[0]!, ctx());

    expect(run?.summary).not.toContain("Dana");
    expect(run?.summary).not.toContain("user_dana");
  });
});

/** The identity check calls HOST code (the memberships callback). It runs before
 *  the run row is written, and the schedule path swallows a rejected run, so a
 *  throw there used to make the whole firing vanish: no row, no audit, nothing to
 *  look at. */
describe("sponsorship — a broken identity seam", () => {
  const twoHoursOn = new Date(NOW.getTime() + 2 * 3_600_000);

  it("leaves a loud failure artifact when the memberships callback throws on a scheduled fire", async () => {
    const { engine, guard, calls } = harness({
      memberships: async () => { throw new Error("host directory is down"); },
    });
    await create(engine, {
      id: "atm_seam_broken", when: { every: "1h" }, task: { kind: "steps", steps: [{ id: "read", tool: readTool.name }] },
    });
    await engine.enable("atm_seam_broken", ctx());

    const [runId] = await engine.tick(twoHoursOn);

    expect(calls).toEqual([]);
    expect(runId).toBeDefined();
    const run = await engine.runs.get(runId!, ctx());
    expect(run).toMatchObject({ status: "error" });
    // The host's raw throw is the AUDIT row's, never the consumer's — the panel
    // renders `summary` and `error.message` verbatim.
    expect(run?.error?.message).not.toContain("host directory is down");
    expect(guard.audit.some((event) =>
      (event.detail as { status?: string; detail?: string }).status === "sponsorship-check-failed"
      && (event.detail as { detail?: string }).detail === "host directory is down")).toBe(true);
  });

  it("terminates a RE-RUN loudly rather than stranding it in \"running\"", async () => {
    const store = memoryStoreAdapter();
    let breakSeam = false;
    const { engine, guard, calls } = harness(
      { store, memberships: async () => { if (breakSeam) throw new Error("host directory is down"); return []; } },
      (call, index) => {
        if (index !== 0) return undefined;
        void store.records("vendo_approvals").put({
          id: "apr_seam",
          data: {
            request: {
              id: "apr_seam",
              call: structuredClone(call),
              descriptor: writeTool,
              inputPreview: "update the invoice",
              ctx: { principal: { kind: "user", subject: "user_dana" }, venue: "automation", presence: "away" },
              createdAt: NOW.toISOString(),
            },
            status: "pending",
          },
        });
        return { status: "pending-approval", approvalId: "apr_seam" };
      },
    );
    await create(engine, {
      id: "atm_seam_rerun",
      when: { event: "go" },
      task: { kind: "steps", steps: [{ id: "write", tool: writeTool.name, args: { invoice: "'inv_42'" } }] },
    });
    await engine.enable("atm_seam_rerun", ctx());
    const [runId] = await engine.emit("go", {}, ctx().principal);

    // The host's directory dies between the failure and the re-run: the fresh run
    // cannot check who it runs as, so it must land a loud terminal row of its own
    // rather than sit in "running" forever.
    breakSeam = true;
    guard.decide("apr_seam", true);
    await flush();
    const rerunId = await engine.runs.rerun(runId!, ctx());

    expect(calls).toHaveLength(1);
    expect(await engine.runs.get(rerunId, ctx())).toMatchObject({ status: "error" });
    expect(guard.audit.some((event) =>
      (event.detail as { status?: string }).status === "sponsorship-check-failed")).toBe(true);
  });

  it("runs normally when the same callback answers", async () => {
    const { engine, calls } = harness({ memberships: async () => [{ org: "maple" }] });
    await create(engine, {
      id: "atm_seam_ok", when: { every: "1h" }, task: { kind: "steps", steps: [{ id: "read", tool: readTool.name }] },
    });
    await engine.enable("atm_seam_ok", ctx());

    const [runId] = await engine.tick(twoHoursOn);

    expect(calls).toHaveLength(1);
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({ status: "ok" });
  });
});

/** The consent rows are generic records, and the 02-store §5 erase cascade finds
 *  generic rows by their REFS. Without them a subject erase (or an automation
 *  delete) leaves the automation's pending asks behind. */
describe("sponsorship — consent rows join the erase cascade", () => {
  it("refs every capture it writes to the subject and the automation", async () => {
    const { store, engine } = harness();
    await create(engine, { id: "atm_refs", when: { event: "go" }, task: steps(), armed: false });

    const { missing } = await engine.enable("atm_refs", ctx());

    expect(missing).not.toHaveLength(0);
    for (const request of missing) {
      expect((await store.records("automations:captures").get(request.id))?.refs)
        .toEqual({ subject: "user_dana", automation_id: "atm_refs" });
    }
  });

  it("relies on the approvals table's own derived refs, which survive a re-put", async () => {
    // `vendo_approvals` is RESERVED: the store derives its refs from the request
    // and ignores whatever a caller passes, and the cascade deletes it by its
    // subject COLUMN. Asserted rather than assumed, because it is the reason
    // captures needed refs and approvals did not.
    const { store, engine, guard } = harness();
    await create(engine, { id: "atm_refs_reserved", when: { event: "go" }, task: steps(), armed: false });
    const { missing } = await engine.enable("atm_refs_reserved", ctx());
    expect((await store.records("vendo_approvals").get(missing[0]!.id))?.refs)
      .toMatchObject({ subject: "user_dana" });

    guard.decide(missing[0]!.id, true);
    await flush();

    const consumed = await store.records("vendo_approvals").get(missing[0]!.id);
    expect(consumed?.data).toMatchObject({ consumedAt: NOW.toISOString() });
    expect(consumed?.refs).toMatchObject({ subject: "user_dana" });
  });
});

/** An automation runs as its SPONSOR, who need not be its owner: an org-held
 *  record is owned by the org and armed by a member. Every door the owner has is
 *  that member's too — otherwise the person it runs as cannot see it, pause it,
 *  or stop it. */
describe("sponsorship — the doors of the person it runs as", () => {
  const orgSponsored = async (automationId: string): Promise<Harness> => {
    const bench = harness({ memberships: async () => [{ org: "maple" }] });
    const owner: Principal = { kind: "org", subject: "maple" };
    await create(
      bench.engine,
      { id: automationId, owner, when: { event: "go" }, task: steps() },
      withOrg("user_omar", "Omar"),
    );
    await bench.engine.enable(automationId, withOrg("user_omar", "Omar"));
    return bench;
  };

  it("lists the record for the member it now runs as, and for nobody outside the org", async () => {
    const { engine } = await orgSponsored("atm_member_doors");

    expect((await engine.list({}, withOrg("user_omar", "Omar"))).map(({ id }) => id))
      .toEqual(["atm_member_doors"]);
    // The owner subject is the ORG, so a caller who asserts no membership and is
    // not the org itself sees nothing at all.
    expect(await engine.list({}, ctx("user_zoe"))).toEqual([]);
  });

  it("lets a member see, dry-run, stop and disable it — and a stranger none of that", async () => {
    const { engine, store } = await orgSponsored("atm_member_control");
    const [runId] = await engine.emit("go", {}, withOrg("user_omar").principal);

    const member = withOrg("user_omar", "Omar");
    expect(await engine.runs.get(runId!, member)).toMatchObject({ id: runId });
    expect((await engine.runs.list({ automationId: "atm_member_control" }, member)).runs).toHaveLength(1);
    expect((await engine.dryRun("atm_member_control", member)).steps).toHaveLength(2);
    await engine.disable("atm_member_control", member);
    expect((await store.records("vendo_automations").get("atm_member_control"))?.data)
      .toMatchObject({ armed: false, disarmedBy: "user" });

    const stranger = ctx("user_zoe");
    expect(await engine.runs.get(runId!, stranger)).toBeNull();
    expect((await engine.runs.list({ automationId: "atm_member_control" }, stranger)).runs).toEqual([]);
    await expect(engine.dryRun("atm_member_control", stranger)).rejects.toThrow(/not found/i);
    await expect(engine.disable("atm_member_control", stranger)).rejects.toThrow(/not found/i);
  });

  it("stops a run for the member it runs as", async () => {
    const { engine } = await orgSponsored("atm_member_stop");
    const member = withOrg("user_omar", "Omar");
    await engine.emit("go", {}, member.principal);
    const [run] = (await engine.runs.list({ automationId: "atm_member_stop" }, member)).runs;

    // A finished run cannot be stopped — the door is what is under test, so a
    // stranger must hear "not found" while the member hears the real conflict.
    await expect(engine.runs.stop(run!.id, ctx("user_zoe"))).rejects.toThrow(/not found/i);
    await expect(engine.runs.stop(run!.id, member)).rejects.toThrow(/cannot be stopped/i);
  });
});

/** What a STOPPED run is allowed to leave behind. Two constraints meet on the
 *  same row:
 *
 *  1. It is read by people: the chrome renders `summary` and `error.message`
 *     verbatim.
 *  2. It is not reachable by a subject erase. `vendo_runs` is keyed to the
 *     AUTOMATION, and an org-held record's owner is the org, which outlives the
 *     person (§9.7). A member arming a record they do not own is exactly what
 *     makes sponsor ≠ owner possible.
 *
 *  So the persisted row may carry neither a person's NAME nor a host system's raw
 *  error text. The live, derived surfaces (the sponsorship row, the audit trail)
 *  carry both — and both ARE erasable. */
describe("sponsorship — what the stopped run row is allowed to say", () => {
  /** The raw persisted row, not the gated `runs.get` projection: what survives an
   *  erase is what is ON DISK, whoever can or cannot read it back. */
  const runRow = async (
    store: StoreAdapter,
    runId: string,
  ): Promise<{ summary?: string; error?: { message: string } }> =>
    ((await store.records("vendo_runs").get(runId))?.data as {
      record: { summary?: string; error?: { message: string } };
    }).record;

  it("keeps the sponsor's NAME off the run row", async () => {
    const { store, engine } = harness();
    const owner: Principal = { kind: "org", subject: "maple" };
    await create(
      engine,
      { id: "atm_name_survives", owner, when: { event: "go" }, task: steps() },
      withOrg("user_dana", "Dana"),
    );
    await engine.enable("atm_name_survives", withOrg("user_dana", "Dana"));
    await create(
      engine,
      { id: "atm_name_survives", owner, when: { event: "go" }, task: steps("inv_3") },
      withOrg("user_dana", "Dana"),
    );

    const [runId] = await engine.emit("go", {}, withOrg("user_dana").principal);

    // The row is written BEFORE any erase — that is the whole problem: nothing
    // rewrites it later, so the name must never go in.
    const persisted = JSON.stringify(await store.records("vendo_runs").get(runId!));
    expect(persisted).not.toContain("Dana");
    expect(persisted).not.toContain("user_dana");

    // The name is not lost to the product: it lives on the sponsorship row, which
    // an erase DOES collect.
    expect(JSON.stringify(await store.records(SPONSORSHIPS).list())).toContain("Dana");
  });

  it("says a broken identity seam in the consumer's voice, and audits the raw failure", async () => {
    const raw = "connect ECONNREFUSED postgres://svc:hunter2@10.0.0.7:5432/directory";
    const { store, engine, guard } = harness({
      memberships: async () => { throw new Error(raw); },
    });
    await create(engine, { id: "atm_seam_voice", when: { event: "go" }, task: steps() });
    await engine.enable("atm_seam_voice", ctx("user_dana", "Dana"));

    const [runId] = await engine.emit("go", {}, ctx().principal);

    const row = await runRow(store, runId!);
    expect(row.summary).not.toContain("ECONNREFUSED");
    expect(row.error?.message).not.toContain("ECONNREFUSED");
    expect(row.summary).toMatch(/could not check who it runs as/);
    // The operator still gets the whole truth — on the audit row, which is
    // subject-keyed and erasable, and which no consumer surface renders.
    expect(guard.audit.some((event) => JSON.stringify(event.detail).includes(raw))).toBe(true);
  });
});

/** An event emitted by a MEMBER of the org fires that org's automations.
 *
 *  `emit` matched on the emitter's own subject, so an ORG-owned host-event
 *  automation could never be fired by anybody: the owner subject is the org id
 *  (§9.5) and no principal is ever an org (§9.1 keeps `kind:"org"` refused at the
 *  wire). The fix shape: walk the orgs the principal asserts, and let the ordinary
 *  fire-time gate decide each run.
 *
 *  As WHOM it runs is unchanged: the SPONSOR (§9.9), never a synthetic org
 *  principal and never the person who happened to trigger it. */
describe("sponsorship — a member's event fires the org's automation", () => {
  /** The org's record, armed by Dana; Kim is an ordinary member of the same org
   *  and emits the event, and Mal is in no org at all. */
  const orgAutomation = async (automationId: string): Promise<Harness> => {
    const bench = harness({
      // §9.1's seam — keyed on Principal precisely so unattended code can ask.
      memberships: async (principal) => principal.subject === "user_mal"
        ? []
        : [{ org: "maple", display: "Maple Bank" }],
    });
    const owner: Principal = { kind: "org", subject: "maple" };
    await create(
      bench.engine,
      { id: automationId, owner, when: { event: "go" }, task: steps() },
      withOrg("user_dana", "Dana"),
    );
    await bench.engine.enable(automationId, withOrg("user_dana", "Dana"));
    return bench;
  };

  it("fires it for a member, and the run acts as the SPONSOR", async () => {
    const { engine, calls } = await orgAutomation("atm_org_emit");

    const ids = await engine.emit("go", {}, { kind: "user", subject: "user_kim" });

    expect(ids).toHaveLength(1);
    expect(calls.map(({ call }) => call.tool)).toEqual([readTool.name, writeTool.name]);
    // Kim's event, Dana's consent — the automation always runs as the person who
    // took it on, never as the person who happened to trigger it.
    expect(calls[0]?.ctx.principal.subject).toBe("user_dana");
    expect(await engine.runs.get(ids[0]!, withOrg("user_dana"))).toMatchObject({
      automationId: "atm_org_emit",
      status: "ok",
    });
  });

  it("fires nothing for a non-member emitting the very same event", async () => {
    const { engine, calls } = await orgAutomation("atm_org_emit_stranger");

    const ids = await engine.emit("go", {}, { kind: "user", subject: "user_mal" });

    expect(ids).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("does not run an org automation whose sponsorship has lapsed — and says why", async () => {
    const { store, engine, calls } = await orgAutomation("atm_org_emit_stopped");
    // The record's task is replaced under it: the sponsorship lapses.
    await create(
      engine,
      {
        id: "atm_org_emit_stopped",
        owner: { kind: "org", subject: "maple" },
        when: { event: "go" },
        task: steps("inv_changed"),
      },
      withOrg("user_dana", "Dana"),
    );

    const ids = await engine.emit("go", {}, { kind: "user", subject: "user_kim" });

    // It stops LOUDLY, exactly as a scheduled fire does: a run row and an audit
    // event, and no tool call at all.
    expect(ids).toHaveLength(1);
    expect(calls).toEqual([]);
    const run = await engine.runs.get(ids[0]!, withOrg("user_dana"));
    expect(run?.status).toBe("error");
    expect(run?.summary).toMatch(/anyone who holds this automation can turn it back on/);
    expect(await sponsorshipRow(store, "atm_org_emit_stopped")).toMatchObject({ status: "invalidated" });
  });
});
