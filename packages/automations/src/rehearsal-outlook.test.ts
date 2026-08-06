/**
 * list()'s `rehearsal` outlook — what a rehearsal WOULD be worth, resolved
 * without replaying anything.
 *
 * It exists so a surface can stop offering an expensive, uninformative
 * rehearsal: a read-only automation costs a full round of real host reads to
 * report that there was nothing to consent to, and an agentic one costs a
 * round trip to return an error. Both are knowable from the document plus the
 * bound descriptors.
 *
 * The contract that matters is agreement: the outlook must use the SAME
 * predicates rehearse() applies, or a panel will advertise a preview the
 * report does not contain. Each case below therefore asserts the outlook and,
 * where the shape is supported, checks it against what rehearse() really does.
 */
import {
  DEFAULT_TRIGGER_ID,
  VENDO_APP_FORMAT,
  type AppDocument,
  type ApprovalId,
  type AuditEvent,
  type Guard,
  type StoreAdapter,
  type ToolDescriptor,
  type Trigger,
  type ToolOutcome,
  type ToolRegistry,
  type RunContext,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { describe, expect, it } from "vitest";
import { createAutomations } from "./index.js";

const NOW = new Date("2026-07-12T12:00:00.000Z");

/** A read with no date bounds: every rehearsed firing re-reads today. */
const balanceTool: ToolDescriptor = {
  name: "host_listAccounts",
  description: "List accounts",
  inputSchema: { type: "object" },
  risk: "read",
};

/** A read rehearse() CAN pin a window onto (acceptsDateBounds). */
const ledgerTool: ToolDescriptor = {
  name: "host_listTransactions",
  description: "List transactions",
  inputSchema: {
    type: "object",
    properties: { from: { type: "string" }, to: { type: "string" } },
  },
  risk: "read",
};

const transferTool: ToolDescriptor = {
  name: "host_transferMoney",
  description: "Move money",
  inputSchema: { type: "object" },
  risk: "destructive",
};

const emailTool: ToolDescriptor = {
  name: "host_sendEmail",
  description: "Send an email",
  inputSchema: { type: "object" },
  risk: "write",
};

const ctx = (subject = "user_a"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "automation",
  presence: "present",
  sessionId: `session_${subject}`,
});

const app = (id: string, trigger: Omit<Trigger, "id">): AppDocument =>
  ({ format: VENDO_APP_FORMAT, id, name: id, triggers: [{ id: DEFAULT_TRIGGER_ID, ...trigger } as Trigger] });

const seedApp = async (
  store: StoreAdapter,
  doc: AppDocument,
  subject = "user_a",
  enabled = false,
): Promise<void> => {
  await store.records("vendo_apps").put({
    id: doc.id,
    data: { subject, enabled, doc },
    refs: { subject, ...(doc.triggers?.[0] === undefined ? {} : { trigger_kind: doc.triggers[0].on.kind }) },
  });
};

class GuardDouble implements Guard {
  async check(): Promise<{ action: "run"; decidedBy: "default" }> {
    return { action: "run", decidedBy: "default" };
  }
  async report(_event: AuditEvent): Promise<void> {}
  async directions(): Promise<string[]> { return []; }
  onApprovalDecision(_cb: (id: ApprovalId, approved: boolean) => void): () => void {
    return () => undefined;
  }
}

const registry = (descriptors: ToolDescriptor[]): ToolRegistry => ({
  async descriptors() { return descriptors; },
  async execute(): Promise<ToolOutcome> { return { status: "ok", output: {} }; },
} as unknown as ToolRegistry);

const engine = (store: StoreAdapter, descriptors: ToolDescriptor[]) => createAutomations({
  apps: { call: async () => ({ status: "ok", output: {} }) } as never,
  tools: registry(descriptors),
  guard: new GuardDouble(),
  store,
  now: () => NOW,
});

const outlookOf = async (doc: AppDocument, descriptors: ToolDescriptor[], enabled = false) => {
  const store = memoryStoreAdapter();
  await seedApp(store, doc, "user_a", enabled);
  const rows = await engine(store, descriptors).list(ctx());
  return rows.find(row => row.app.id === doc.id)!.triggers[0]!.rehearsal!;
};

describe("rehearsal outlook", () => {
  it("counts a destructive step as an action, and a bounded read as historical", async () => {
    const outlook = await outlookOf(
      app("app_sweep", {
        on: { kind: "schedule", cron: "0 18 * * 5" },
        run: {
          kind: "steps",
          steps: [
            { id: "week", tool: ledgerTool.name },
            { id: "sweep", tool: transferTool.name },
          ],
        },
      }),
      [ledgerTool, transferTool],
    );
    expect(outlook).toEqual({
      supported: true,
      actingSteps: 1,
      readSteps: 1,
      historicalReads: 1,
    });
  });

  it("reports zero acting steps for a read-only automation — the case worth not offering", async () => {
    const outlook = await outlookOf(
      app("app_digest", {
        on: { kind: "schedule", cron: "0 8 * * 1" },
        run: {
          kind: "steps",
          steps: [
            { id: "a", tool: balanceTool.name },
            { id: "b", tool: ledgerTool.name },
          ],
        },
      }),
      [balanceTool, ledgerTool],
    );
    expect(outlook.actingSteps).toBe(0);
    // Historical data does NOT make it worth rehearsing: one of these two
    // reads replays a real window and there is still nothing to consent to.
    expect(outlook.historicalReads).toBe(1);
    expect(outlook.readSteps).toBe(2);
  });

  it("separates an unbounded read from a bounded one, so repeats are predictable", async () => {
    const outlook = await outlookOf(
      app("app_mixed", {
        on: { kind: "schedule", cron: "0 17 * * 5" },
        run: {
          kind: "steps",
          steps: [
            { id: "snap", tool: balanceTool.name },
            { id: "ledger", tool: ledgerTool.name },
            { id: "mail", tool: emailTool.name },
          ],
        },
      }),
      [balanceTool, ledgerTool, emailTool],
    );
    expect(outlook).toEqual({
      supported: true,
      actingSteps: 1,
      readSteps: 2,
      historicalReads: 1,
    });
  });

  it("marks an agentic run unsupported — and rehearse() really does reject it", async () => {
    const doc = app("app_agentic", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "agentic", prompt: "do the thing" },
    });
    expect((await outlookOf(doc, [balanceTool])).supported).toBe(false);

    const store = memoryStoreAdapter();
    await seedApp(store, doc);
    await expect(engine(store, [balanceTool]).rehearse(doc.id, DEFAULT_TRIGGER_ID, ctx()))
      .rejects.toThrow(/steps automations only/);
  });

  it("marks a non-schedule trigger unsupported — and rehearse() really does reject it", async () => {
    const doc = app("app_event", {
      on: { kind: "host-event", event: "payment.created" },
      run: { kind: "steps", steps: [{ id: "a", tool: balanceTool.name }] },
    });
    expect((await outlookOf(doc, [balanceTool])).supported).toBe(false);

    const store = memoryStoreAdapter();
    await seedApp(store, doc);
    await expect(engine(store, [balanceTool]).rehearse(doc.id, DEFAULT_TRIGGER_ID, ctx()))
      .rejects.toThrow(/schedule triggers only/);
  });

  it("ignores fn: steps, which rehearsal skips rather than executing", async () => {
    const outlook = await outlookOf(
      app("app_fn", {
        on: { kind: "schedule", cron: "0 8 * * *" },
        run: {
          kind: "steps",
          steps: [
            { id: "a", tool: ledgerTool.name },
            { id: "b", tool: "fn:summarize" },
          ],
        },
      }),
      [ledgerTool],
    );
    expect(outlook).toEqual({
      supported: true,
      actingSteps: 0,
      readSteps: 1,
      historicalReads: 1,
    });
  });

  it("marks an unknown non-fn: tool unsupported — and rehearse() really does reject it", async () => {
    const doc = app("app_unknown", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: {
        kind: "steps",
        steps: [
          { id: "read", tool: ledgerTool.name },
          { id: "act", tool: "host_not_bound" },
        ],
      },
    });
    // A schedule+steps shape, but one step names a tool the guard cannot resolve:
    // rehearse() would throw, so the outlook must not advertise the action.
    expect((await outlookOf(doc, [ledgerTool])).supported).toBe(false);

    const store = memoryStoreAdapter();
    await seedApp(store, doc);
    await expect(engine(store, [ledgerTool]).rehearse(doc.id, DEFAULT_TRIGGER_ID, ctx()))
      .rejects.toThrow(/unknown tool/);
  });

  it("does NOT count a read that hard-codes both bounds as historical (it repeats a fixed range)", async () => {
    const outlook = await outlookOf(
      app("app_fixed", {
        on: { kind: "schedule", cron: "0 17 * * 5" },
        run: {
          kind: "steps",
          steps: [
            // Both from AND to fixed: rehearse()'s `??=` leaves them, so every
            // firing re-reads the same range — not a per-firing historical window.
            { id: "fixed", tool: ledgerTool.name, args: { from: "'2026-01-01'", to: "'2026-02-01'" } },
          ],
        },
      }),
      [ledgerTool],
    );
    expect(outlook).toMatchObject({ readSteps: 1, historicalReads: 0 });
  });

  it("drops the control when no selectable window contains a firing (one-shot `at` out of range)", async () => {
    // 41 days before NOW: outside even the widest (30d) window, so every
    // replay would be empty no matter which window the user picks — the
    // outlook must not advertise an action that opens an empty report.
    const stale = app("app_oneshot_stale", {
      on: { kind: "schedule", at: "2026-06-01T09:00:00.000Z" },
      run: { kind: "steps", steps: [{ id: "read", tool: ledgerTool.name }] },
    });
    expect((await outlookOf(stale, [ledgerTool])).supported).toBe(false);

    // …and rehearse() really does replay nothing for it.
    const store = memoryStoreAdapter();
    await seedApp(store, stale);
    const report = await engine(store, [ledgerTool]).rehearse(stale.id, DEFAULT_TRIGGER_ID, ctx());
    expect(report.firings).toHaveLength(0);

    // A future instant can never have "would have fired" either.
    const future = app("app_oneshot_future", {
      on: { kind: "schedule", at: "2026-08-01T09:00:00.000Z" },
      run: { kind: "steps", steps: [{ id: "read", tool: ledgerTool.name }] },
    });
    expect((await outlookOf(future, [ledgerTool])).supported).toBe(false);

    // Inside the 30-day window the one-shot IS worth offering.
    const recent = app("app_oneshot_recent", {
      on: { kind: "schedule", at: "2026-07-01T09:00:00.000Z" },
      run: { kind: "steps", steps: [{ id: "read", tool: ledgerTool.name }] },
    });
    expect((await outlookOf(recent, [ledgerTool])).supported).toBe(true);
  });

  it("classifies steps through the live risk classifier, so counts match what rehearse() replays", async () => {
    // A classifier that reclassifies the statically-read ledger tool as a
    // write (a connector or arg-sensitive grader). rehearse() would simulate
    // that step, so the outlook must count it as an acting step — advertising
    // a historical read here would promise a row the report never contains.
    const store = memoryStoreAdapter();
    const doc = app("app_reclassified", {
      on: { kind: "schedule", cron: "0 17 * * 5" },
      run: { kind: "steps", steps: [{ id: "ledger", tool: ledgerTool.name }] },
    });
    await seedApp(store, doc);
    const automations = createAutomations({
      apps: {
        call: async () => ({ status: "ok", output: {} }),
        agentToolRisk: async () => "write" as const,
      } as never,
      tools: registry([ledgerTool]),
      guard: new GuardDouble(),
      store,
      now: () => NOW,
    });
    const outlook = (await automations.list(ctx())).find(row => row.app.id === doc.id)!.triggers[0]!.rehearsal!;
    expect(outlook).toEqual({ supported: true, actingSteps: 1, readSteps: 0, historicalReads: 0 });
  });

  it("marks an ENABLED automation unsupported — and rehearse() really does reject it", async () => {
    const doc = app("app_live", {
      on: { kind: "schedule", cron: "0 18 * * 5" },
      run: { kind: "steps", steps: [{ id: "read", tool: ledgerTool.name }] },
    });
    // Rehearsal is the pre-enable step; an enabled row is rejected, so the list
    // must not offer the control for it either.
    expect((await outlookOf(doc, [ledgerTool], true)).supported).toBe(false);
    expect((await outlookOf(doc, [ledgerTool], false)).supported).toBe(true);

    const store = memoryStoreAdapter();
    await seedApp(store, doc, "user_a", true);
    await expect(engine(store, [ledgerTool]).rehearse(doc.id, DEFAULT_TRIGGER_ID, ctx()))
      .rejects.toThrow(/pre-enable/);
  });
});
