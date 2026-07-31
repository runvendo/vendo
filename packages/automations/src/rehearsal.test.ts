import {
  VENDO_APP_FORMAT,
  VendoError,
  type AppDocument,
  type ApprovalId,
  type AuditEvent,
  type Guard,
  type RehearsalSimulation,
  type RunContext,
  type StoreAdapter,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { describe, expect, it } from "vitest";
import { createAutomations } from "./index.js";

/**
 * rehearse() — the trailing-30-days replay of a schedule trigger through the
 * steps executor under the guard's rehearsal venue. The registry double here
 * plays the role of the ALREADY guard-bound registry the engine is composed
 * with: reads answer real data, write/destructive tools answer the guard's
 * simulated card (the read-vs-write split itself is the guard's and is tested
 * in packages/guard/test/rehearsal-venue.test.ts).
 */

const NOW = new Date("2026-07-12T12:00:00.000Z");
const DAY = 86_400_000;

const balanceTool: ToolDescriptor = {
  name: "host_listAccounts",
  description: "List accounts",
  inputSchema: { type: "object" },
  risk: "read",
};

const transactionsTool: ToolDescriptor = {
  name: "host_listTransactions",
  description: "List transactions",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string" },
      to: { type: "string" },
      category: { type: "string" },
    },
  },
  risk: "read",
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
  requestHeaders: { cookie: "session=live" },
});

const app = (id: string, trigger: NonNullable<AppDocument["trigger"]>): AppDocument =>
  ({ format: VENDO_APP_FORMAT, id, name: id, trigger });

const seedApp = async (store: StoreAdapter, doc: AppDocument, subject = "user_a"): Promise<void> => {
  await store.records("vendo_apps").put({
    id: doc.id,
    data: { subject, enabled: false, doc },
    refs: { subject, ...(doc.trigger === undefined ? {} : { trigger_kind: doc.trigger.on.kind }) },
  });
};

class GuardDouble implements Guard {
  readonly audit: AuditEvent[] = [];
  async check(): Promise<{ action: "run"; decidedBy: "default" }> {
    return { action: "run", decidedBy: "default" };
  }
  async report(event: AuditEvent): Promise<void> {
    this.audit.push(structuredClone(event));
  }
  async directions(): Promise<string[]> { return []; }
  onApprovalDecision(_cb: (id: ApprovalId, approved: boolean) => void): () => void {
    return () => undefined;
  }
}

/** A guard-bound registry double: reads execute "for real" via `read`,
 *  writes/destructive answer the guard's simulated card without executing. */
const guardBoundRegistry = (
  descriptors: ToolDescriptor[],
  read: (call: ToolCall, runCtx: RunContext) => ToolOutcome = () => ({ status: "ok", output: {} }),
): ToolRegistry & { calls: Array<{ call: ToolCall; ctx: RunContext }>; writesExecuted: number } => {
  const state = {
    calls: [] as Array<{ call: ToolCall; ctx: RunContext }>,
    writesExecuted: 0,
  };
  return {
    calls: state.calls,
    get writesExecuted() { return state.writesExecuted; },
    async descriptors() { return descriptors; },
    async execute(call, runCtx) {
      state.calls.push({ call: structuredClone(call), ctx: structuredClone(runCtx) });
      const descriptor = descriptors.find((candidate) => candidate.name === call.tool);
      if (runCtx.venue === "rehearsal" && descriptor !== undefined && descriptor.risk !== "read") {
        const output: RehearsalSimulation = {
          rehearsalSimulated: true,
          tool: call.tool,
          risk: descriptor.risk,
          args: structuredClone(call.args),
        };
        return { status: "ok", output };
      }
      if (descriptor !== undefined && descriptor.risk !== "read") state.writesExecuted += 1;
      return read(call, runCtx);
    },
  };
};

const engine = (
  store: StoreAdapter,
  tools: ToolRegistry,
  guard: Guard = new GuardDouble(),
) => createAutomations({
  apps: { call: async () => ({ status: "ok", output: {} }) } as never,
  tools,
  guard,
  store,
  now: () => NOW,
});

describe("rehearse() fire-time enumeration", () => {
  it("enumerates a daily cron's firings over the trailing 30 days, oldest first", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_daily", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    });
    await seedApp(store, doc);
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    const report = await automations.rehearse("app_daily", ctx());
    // Window: 2026-06-12T12:00Z → 2026-07-12T12:00Z; 08:00 firings land on
    // Jun 13 … Jul 12 (Jun 12 08:00 precedes the window start).
    expect(report.firings).toHaveLength(30);
    expect(report.firings[0]?.scheduledFor).toBe("2026-06-13T08:00:00.000Z");
    expect(report.firings.at(-1)?.scheduledFor).toBe("2026-07-12T08:00:00.000Z");
    expect(report.truncated).toBeUndefined();
    expect(report.from).toBe("2026-06-12T12:00:00.000Z");
    expect(report.to).toBe("2026-07-12T12:00:00.000Z");
  });

  it("enumerates a weekly cron (Fridays 17:00) — five Fridays in the window", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_weekly", {
      on: { kind: "schedule", cron: "0 17 * * 5" },
      run: { kind: "steps", steps: [{ id: "transactions", tool: "host_listTransactions" }] },
    });
    await seedApp(store, doc);
    const automations = engine(store, guardBoundRegistry([transactionsTool]));
    const report = await automations.rehearse("app_weekly", ctx());
    expect(report.firings.map((firing) => firing.scheduledFor)).toEqual([
      "2026-06-12T17:00:00.000Z",
      "2026-06-19T17:00:00.000Z",
      "2026-06-26T17:00:00.000Z",
      "2026-07-03T17:00:00.000Z",
      "2026-07-10T17:00:00.000Z",
    ]);
  });

  it("anchors `every` cadences at the window end and includes an in-window `at` once", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, app("app_every", {
      on: { kind: "schedule", every: "1d" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    }));
    await seedApp(store, app("app_at", {
      on: { kind: "schedule", at: "2026-07-01T09:00:00.000Z" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    }));
    await seedApp(store, app("app_at_past", {
      on: { kind: "schedule", at: "2026-01-01T09:00:00.000Z" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    }));
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    const every = await automations.rehearse("app_every", ctx());
    expect(every.firings).toHaveLength(30);
    expect(every.firings.at(-1)?.scheduledFor).toBe("2026-07-11T12:00:00.000Z");
    expect((await automations.rehearse("app_at", ctx())).firings.map((firing) => firing.scheduledFor))
      .toEqual(["2026-07-01T09:00:00.000Z"]);
    expect((await automations.rehearse("app_at_past", ctx())).firings).toHaveLength(0);
  });

  it("caps dense schedules at the most recent firings and says so", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_hourly", {
      on: { kind: "schedule", cron: "0 * * * *" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    });
    await seedApp(store, doc);
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    const report = await automations.rehearse("app_hourly", ctx());
    expect(report.truncated).toBe(true);
    expect(report.firings).toHaveLength(62);
    // The MOST RECENT firings are kept.
    expect(report.firings.at(-1)?.scheduledFor).toBe("2026-07-12T12:00:00.000Z");
  });

  it("a truncated schedule's first kept firing windows back to the discarded previous firing", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, app("app_hourly_windowed", {
      on: { kind: "schedule", cron: "0 * * * *" },
      run: { kind: "steps", steps: [{ id: "transactions", tool: "host_listTransactions" }] },
    }));
    await seedApp(store, app("app_every_dense", {
      on: { kind: "schedule", every: "1h" },
      run: { kind: "steps", steps: [{ id: "transactions", tool: "host_listTransactions" }] },
    }));
    const automations = engine(store, guardBoundRegistry([transactionsTool]));
    const cron = await automations.rehearse("app_hourly_windowed", ctx());
    expect(cron.truncated).toBe(true);
    expect(cron.firings[0]?.scheduledFor).toBe("2026-07-09T23:00:00.000Z");
    // One schedule interval, not the full 30-day report window.
    expect(cron.firings[0]?.steps[0]?.window).toEqual({
      from: "2026-07-09T22:00:00.000Z",
      to: "2026-07-09T23:00:00.000Z",
    });
    const every = await automations.rehearse("app_every_dense", ctx());
    expect(every.truncated).toBe(true);
    expect(every.firings[0]?.scheduledFor).toBe("2026-07-09T22:00:00.000Z");
    expect(every.firings[0]?.steps[0]?.window).toEqual({
      from: "2026-07-09T21:00:00.000Z",
      to: "2026-07-09T22:00:00.000Z",
    });
  });
});

describe("rehearse() executes steps under the rehearsal venue", () => {
  it("reads run for real; writes come back simulated with args resolved from REAL upstream outputs", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_alert", {
      on: { kind: "schedule", cron: "0 17 * * 5" },
      run: {
        kind: "steps",
        steps: [
          { id: "balance", tool: "host_listAccounts" },
          {
            id: "alert",
            tool: "host_sendEmail",
            args: { body: "'Balance is ' & $string(steps.balance.balance)" },
          },
        ],
      },
    });
    await seedApp(store, doc);
    const tools = guardBoundRegistry(
      [balanceTool, emailTool],
      () => ({ status: "ok", output: { balance: 1500 } }),
    );
    const automations = engine(store, tools);
    const report = await automations.rehearse("app_alert", ctx());
    expect(report.firings.length).toBeGreaterThan(0);
    for (const firing of report.firings) {
      expect(firing.status).toBe("fired");
      expect(firing.simulatedActions).toBe(1);
      const [balance, alert] = firing.steps;
      expect(balance).toMatchObject({ id: "balance", status: "ok" });
      // The simulated card carries the JSONata-resolved args — computed from
      // the read's REAL output, not a placeholder.
      expect(alert).toMatchObject({
        id: "alert",
        status: "simulated",
        args: { body: "Balance is 1500" },
      });
    }
    // The write tool itself never executed.
    expect(tools.writesExecuted).toBe(0);
    // Every call rode the rehearsal venue on the caller's live session —
    // request headers included, so present-venue host reads authenticate
    // exactly as chat reads do.
    for (const { ctx: callCtx } of tools.calls) {
      expect(callCtx.venue).toBe("rehearsal");
      expect(callCtx.presence).toBe("present");
      expect(callCtx.sessionId).toBe("session_user_a");
      expect(callCtx.appId).toBe("app_alert");
      expect(callCtx.requestHeaders).toEqual({ cookie: "session=live" });
    }
  });

  it("pins date bounds to the firing's window when the tool accepts from/to; labels the rest today", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_digest", {
      on: { kind: "schedule", cron: "0 17 * * 5" },
      run: {
        kind: "steps",
        steps: [
          { id: "balance", tool: "host_listAccounts" },
          { id: "transactions", tool: "host_listTransactions" },
        ],
      },
    });
    await seedApp(store, doc);
    const tools = guardBoundRegistry([balanceTool, transactionsTool]);
    const automations = engine(store, tools);
    const report = await automations.rehearse("app_digest", ctx());
    const second = report.firings[1];
    expect(second?.scheduledFor).toBe("2026-06-19T17:00:00.000Z");
    const [balance, transactions] = second?.steps ?? [];
    expect(balance).toMatchObject({ status: "ok", evaluatedOn: "today" });
    expect(balance?.window).toBeUndefined();
    // Window reaches back to the PREVIOUS firing.
    expect(transactions).toMatchObject({
      status: "ok",
      evaluatedOn: "window",
      window: { from: "2026-06-12T17:00:00.000Z", to: "2026-06-19T17:00:00.000Z" },
    });
    const pinnedCall = tools.calls.find(({ call, ctx: callCtx }) =>
      call.tool === "host_listTransactions"
      && (call.args as Record<string, unknown>)["to"] === "2026-06-19T17:00:00.000Z");
    expect(pinnedCall).toBeDefined();
    expect((pinnedCall?.call.args as Record<string, unknown>)["from"]).toBe("2026-06-12T17:00:00.000Z");
    // The first firing falls back to the report window's own start.
    expect(report.firings[0]?.steps[1]?.window?.from).toBe("2026-06-12T12:00:00.000Z");
  });

  it("evaluates if-conditions per firing on the firing's event; false skips the step", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_conditional", {
      on: { kind: "schedule", cron: "0 17 * * 5" },
      run: {
        kind: "steps",
        steps: [{
          id: "balance",
          tool: "host_listAccounts",
          // Only fires in June.
          if: "$contains(event.firedAt, '2026-06')",
        }],
      },
    });
    await seedApp(store, doc);
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    const report = await automations.rehearse("app_conditional", ctx());
    const june = report.firings.filter((firing) => firing.scheduledFor.startsWith("2026-06"));
    const july = report.firings.filter((firing) => firing.scheduledFor.startsWith("2026-07"));
    expect(june.every((firing) => firing.status === "fired")).toBe(true);
    expect(july.every((firing) => firing.status === "skipped")).toBe(true);
    expect(july[0]?.steps[0]).toMatchObject({ status: "skipped" });
  });

  it("persists nothing to run history and requires no grants", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_daily", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    });
    await seedApp(store, doc);
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    const report = await automations.rehearse("app_daily", ctx());
    expect(report.firings).toHaveLength(30);
    expect((await store.records("vendo_runs").list({})).records).toHaveLength(0);
    expect((await store.records("vendo_grants").list({})).records).toHaveLength(0);
    expect((await store.records("vendo_approvals").list({})).records).toHaveLength(0);
  });

  it("a blocked call stops the firing with an error row; later firings still rehearse", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_blocked", {
      on: { kind: "schedule", cron: "0 17 * * 5" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    });
    await seedApp(store, doc);
    let callIndex = 0;
    const tools = guardBoundRegistry([balanceTool], () => {
      callIndex += 1;
      return callIndex === 1
        ? { status: "blocked", reason: "not now" }
        : { status: "ok", output: {} };
    });
    const automations = engine(store, tools);
    const report = await automations.rehearse("app_blocked", ctx());
    expect(report.firings[0]).toMatchObject({ status: "error" });
    expect(report.firings[0]?.steps[0]).toMatchObject({ status: "blocked", detail: "not now" });
    expect(report.firings.slice(1).every((firing) => firing.status === "fired")).toBe(true);
  });
});

describe("rehearse() scope guards", () => {
  it("rejects non-schedule triggers and agentic runs (v1 scope)", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, app("app_event", {
      on: { kind: "host-event", event: "invoice.created" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    }));
    await seedApp(store, app("app_agentic", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "agentic", prompt: "watch my balance" },
    }));
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    await expect(automations.rehearse("app_event", ctx())).rejects.toThrow(VendoError);
    await expect(automations.rehearse("app_event", ctx())).rejects.toThrow(/schedule triggers only/);
    await expect(automations.rehearse("app_agentic", ctx())).rejects.toThrow(/steps automations only/);
  });

  it("is owner-scoped: a foreign subject gets not-found", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, app("app_daily", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    }));
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    await expect(automations.rehearse("app_daily", ctx("user_b"))).rejects.toThrow(/not found/);
  });

  it("rejects an unknown tool up front", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, app("app_unknown", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "x", tool: "host_missing" }] },
    }));
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    await expect(automations.rehearse("app_unknown", ctx())).rejects.toThrow(/unknown tool/);
  });
});
