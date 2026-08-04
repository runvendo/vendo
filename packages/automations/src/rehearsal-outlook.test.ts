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
  VENDO_APP_FORMAT,
  type AppDocument,
  type ApprovalId,
  type AuditEvent,
  type Guard,
  type StoreAdapter,
  type ToolDescriptor,
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

const app = (id: string, trigger: NonNullable<AppDocument["trigger"]>): AppDocument =>
  ({ format: VENDO_APP_FORMAT, id, name: id, trigger });

const seedApp = async (
  store: StoreAdapter,
  doc: AppDocument,
  subject = "user_a",
  enabled = false,
): Promise<void> => {
  await store.records("vendo_apps").put({
    id: doc.id,
    data: { subject, enabled, doc },
    refs: { subject, ...(doc.trigger === undefined ? {} : { trigger_kind: doc.trigger.on.kind }) },
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
  return rows.find(row => row.app.id === doc.id)!.rehearsal!;
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
    await expect(engine(store, [balanceTool]).rehearse(doc.id, ctx()))
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
    await expect(engine(store, [balanceTool]).rehearse(doc.id, ctx()))
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
    await expect(engine(store, [ledgerTool]).rehearse(doc.id, ctx()))
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
    await expect(engine(store, [ledgerTool]).rehearse(doc.id, ctx()))
      .rejects.toThrow(/pre-enable/);
  });
});
