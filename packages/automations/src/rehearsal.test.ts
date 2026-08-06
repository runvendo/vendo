import {
  DEFAULT_TRIGGER_ID,
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
  type Trigger,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { describe, expect, it } from "vitest";
import { createAutomations, type AutomationsConfig } from "./index.js";

/**
 * rehearse() — the trailing-window replay of a schedule trigger through the
 * steps executor under the guard's rehearsal venue. The window is selectable
 * (7 or 30 days, defaulting to 30 when omitted); tests that assert exact
 * firing counts/dates against a 7-day gap pass `windowDays: 7` explicitly so
 * their intent survives the 30-day default. The registry double here plays the
 * role of the ALREADY guard-bound registry the engine is composed with: reads
 * answer real data, write/destructive tools answer the guard's simulated card
 * (the read-vs-write split itself is the guard's and is tested in
 * packages/guard/test/rehearsal-venue.test.ts).
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

const app = (id: string, trigger: Omit<Trigger, "id">): AppDocument =>
  ({ format: VENDO_APP_FORMAT, id, name: id, triggers: [{ id: DEFAULT_TRIGGER_ID, ...trigger } as Trigger] });

const seedApp = async (store: StoreAdapter, doc: AppDocument, subject = "user_a"): Promise<void> => {
  await store.records("vendo_apps").put({
    id: doc.id,
    data: { subject, enabled: false, doc },
    refs: { subject, ...(doc.triggers?.[0] === undefined ? {} : { trigger_kind: doc.triggers[0].on.kind }) },
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
  /** Stands in for the guard's honest would-be-live verdict on a simulated
   *  write (resolved in packages/guard; here it's supplied so the engine's
   *  threading of it onto RehearsalStep can be asserted). */
  simulate?: (call: ToolCall, descriptor: ToolDescriptor) =>
    Pick<RehearsalSimulation, "wouldAsk" | "grantsMissing"> & { wouldBlock?: string },
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
          ...(simulate === undefined ? {} : simulate(call, descriptor)),
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
  /** The merged `.vendo` semantics view the umbrella passes in (value or
   *  provider form) — what rehearse() summarizes money with. */
  semantics?: AutomationsConfig["semantics"],
) => createAutomations({
  apps: { call: async () => ({ status: "ok", output: {} }) } as never,
  tools,
  guard,
  store,
  now: () => NOW,
  ...(semantics === undefined ? {} : { semantics }),
});

describe("rehearse() fire-time enumeration", () => {
  it("enumerates a daily cron's firings over the trailing 7 days, oldest first", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_daily", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    });
    await seedApp(store, doc);
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    const report = await automations.rehearse("app_daily", DEFAULT_TRIGGER_ID, ctx(), 7);
    // Window: 2026-07-05T12:00Z → 2026-07-12T12:00Z; 08:00 firings land on
    // Jul 6 … Jul 12 (Jul 5 08:00 precedes the window start).
    expect(report.windowDays).toBe(7);
    expect(report.firings).toHaveLength(7);
    expect(report.firings[0]?.scheduledFor).toBe("2026-07-06T08:00:00.000Z");
    expect(report.firings.at(-1)?.scheduledFor).toBe("2026-07-12T08:00:00.000Z");
    expect(report.truncated).toBeUndefined();
    expect(report.from).toBe("2026-07-05T12:00:00.000Z");
    expect(report.to).toBe("2026-07-12T12:00:00.000Z");
  });

  it("enumerates a weekly cron (Fridays 17:00) — the single Friday in the window", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_weekly", {
      on: { kind: "schedule", cron: "0 17 * * 5" },
      run: { kind: "steps", steps: [{ id: "transactions", tool: "host_listTransactions" }] },
    });
    await seedApp(store, doc);
    const automations = engine(store, guardBoundRegistry([transactionsTool]));
    const report = await automations.rehearse("app_weekly", DEFAULT_TRIGGER_ID, ctx(), 7);
    expect(report.firings.map((firing) => firing.scheduledFor)).toEqual([
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
      on: { kind: "schedule", at: "2026-07-08T09:00:00.000Z" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    }));
    await seedApp(store, app("app_at_past", {
      on: { kind: "schedule", at: "2026-01-01T09:00:00.000Z" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    }));
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    const every = await automations.rehearse("app_every", DEFAULT_TRIGGER_ID, ctx(), 7);
    expect(every.firings).toHaveLength(7);
    expect(every.firings.at(-1)?.scheduledFor).toBe("2026-07-11T12:00:00.000Z");
    expect((await automations.rehearse("app_at", DEFAULT_TRIGGER_ID, ctx(), 7)).firings.map((firing) => firing.scheduledFor))
      .toEqual(["2026-07-08T09:00:00.000Z"]);
    expect((await automations.rehearse("app_at_past", DEFAULT_TRIGGER_ID, ctx(), 7)).firings).toHaveLength(0);
  });

  it("caps dense schedules at the most recent firings and says so", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_hourly", {
      on: { kind: "schedule", cron: "0 * * * *" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    });
    await seedApp(store, doc);
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    const report = await automations.rehearse("app_hourly", DEFAULT_TRIGGER_ID, ctx(), 7);
    expect(report.truncated).toBe(true);
    // 168 hourly firings in the 7-day window, capped to the most recent 30.
    expect(report.firings).toHaveLength(30);
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
    const cron = await automations.rehearse("app_hourly_windowed", DEFAULT_TRIGGER_ID, ctx(), 7);
    expect(cron.truncated).toBe(true);
    // Most recent 30 of 168: the last is 12:00 Jul 12, so the first kept is
    // 29 hours earlier.
    expect(cron.firings[0]?.scheduledFor).toBe("2026-07-11T07:00:00.000Z");
    // One schedule interval, not the full 7-day report window.
    expect(cron.firings[0]?.steps[0]?.window).toEqual({
      from: "2026-07-11T06:00:00.000Z",
      to: "2026-07-11T07:00:00.000Z",
    });
    const every = await automations.rehearse("app_every_dense", DEFAULT_TRIGGER_ID, ctx(), 7);
    expect(every.truncated).toBe(true);
    // `every` anchors at the window END, so its most recent firing is 11:00
    // (one interval before `to`) and the 30th back is 06:00 Jul 11.
    expect(every.firings[0]?.scheduledFor).toBe("2026-07-11T06:00:00.000Z");
    expect(every.firings[0]?.steps[0]?.window).toEqual({
      from: "2026-07-11T05:00:00.000Z",
      to: "2026-07-11T06:00:00.000Z",
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
    const report = await automations.rehearse("app_alert", DEFAULT_TRIGGER_ID, ctx());
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

  it("threads the guard's would-ask / grants-missing verdict from the simulated card onto the step", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_verdict", {
      on: { kind: "schedule", cron: "0 17 * * 5" },
      run: { kind: "steps", steps: [{ id: "alert", tool: "host_sendEmail" }] },
    });
    await seedApp(store, doc);
    // The guard-bound registry double reports the write would still ask (no
    // standing grant captured yet) — the engine must surface that on the row.
    const tools = guardBoundRegistry(
      [emailTool],
      () => ({ status: "ok", output: {} }),
      (call) => ({ wouldAsk: true, grantsMissing: [call.tool] }),
    );
    const firing = (await engine(store, tools).rehearse("app_verdict", DEFAULT_TRIGGER_ID, ctx())).firings[0];
    const step = firing?.steps[0];
    expect(step).toMatchObject({
      id: "alert",
      status: "simulated",
      wouldAsk: true,
      grantsMissing: ["host_sendEmail"],
    });
    expect(step?.wouldBlock).toBeUndefined();
  });

  it("threads a policy wouldBlock verdict onto the simulated step", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_blocked", {
      on: { kind: "schedule", cron: "0 17 * * 5" },
      run: { kind: "steps", steps: [{ id: "alert", tool: "host_sendEmail" }] },
    });
    await seedApp(store, doc);
    const tools = guardBoundRegistry(
      [emailTool],
      () => ({ status: "ok", output: {} }),
      () => ({ wouldAsk: false, grantsMissing: [], wouldBlock: "writes are off in this app" }),
    );
    const step = (await engine(store, tools).rehearse("app_blocked", DEFAULT_TRIGGER_ID, ctx())).firings[0]?.steps[0];
    expect(step).toMatchObject({ status: "simulated", wouldBlock: "writes are off in this app" });
    expect(step?.wouldAsk).toBeUndefined();
    expect(step?.grantsMissing).toBeUndefined();
  });

  it("a plain simulated write (would run once live) carries no verdict fields on the step", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_plain", {
      on: { kind: "schedule", cron: "0 17 * * 5" },
      run: { kind: "steps", steps: [{ id: "alert", tool: "host_sendEmail" }] },
    });
    await seedApp(store, doc);
    // Default double: no verdict → wouldAsk:false/grantsMissing:[] not emitted.
    const step = (await engine(store, guardBoundRegistry([emailTool])).rehearse("app_plain", DEFAULT_TRIGGER_ID, ctx())).firings[0]?.steps[0];
    expect(step).toMatchObject({ status: "simulated" });
    expect(step?.wouldAsk).toBeUndefined();
    expect(step?.grantsMissing).toBeUndefined();
    expect(step?.wouldBlock).toBeUndefined();
  });

  it("a non-money numeric field (a plain count) never renders as a money headline", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_count", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "rows", tool: "host_listAccounts" }] },
    });
    await seedApp(store, doc);
    const tools = guardBoundRegistry([balanceTool], () => ({
      status: "ok",
      output: [{ name: "Inbox", count: 120 }, { name: "Archive", count: 43 }],
    }));
    const semantics = { host_listAccounts: { count: { kind: "plain" } } } as const;
    const step = (await engine(store, tools, new GuardDouble(), semantics)
      .rehearse("app_count", DEFAULT_TRIGGER_ID, ctx())).firings[0]?.steps[0];
    // The one shared numeric field is `count`, which the host's sync classified
    // as anything but money — so no headline (this once rendered $1.20/$0.43).
    expect(step?.result).toBeUndefined();
    // The raw data still reaches the client through the preview, untouched.
    expect(step?.preview).toContain("count");
  });

  it("sums the field the host's semantics call money, ignoring the other shared numeric", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_amount", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "rows", tool: "host_listAccounts" }] },
    });
    await seedApp(store, doc);
    const tools = guardBoundRegistry([balanceTool], () => ({
      status: "ok",
      output: [{ name: "Dining", amount: 5_000, count: 3 }, { name: "Transit", amount: 2_500, count: 9 }],
    }));
    const semantics = { host_listAccounts: { amount: { kind: "money", unit: "cents" } } } as const;
    const step = (await engine(store, tools, new GuardDouble(), semantics)
      .rehearse("app_amount", DEFAULT_TRIGGER_ID, ctx())).firings[0]?.steps[0];
    // Two shared numerics (amount, count); only `amount` is declared money, so
    // it's the unambiguous headline field — count is ignored, not summed.
    expect(step?.result?.totalCents).toBe(7_500);
    expect(step?.result?.breakdown).toEqual([
      { label: "Dining", cents: 5_000 },
      { label: "Transit", cents: 2_500 },
    ]);
  });

  it("scales a money.dollars field into the headline's minor units", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, app("app_dollars", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "rows", tool: "host_listAccounts" }] },
    }));
    const tools = guardBoundRegistry([balanceTool], () => ({
      status: "ok",
      output: [{ name: "Dining", amount: 50.25 }, { name: "Transit", amount: 25 }],
    }));
    const semantics = { host_listAccounts: { amount: { kind: "money", unit: "dollars" } } } as const;
    const step = (await engine(store, tools, new GuardDouble(), semantics)
      .rehearse("app_dollars", DEFAULT_TRIGGER_ID, ctx())).firings[0]?.steps[0];
    // `result` is minor units by contract, so dollars scale here — without the
    // synced unit this read would have rendered $0.50 instead of $50.25.
    expect(step?.result?.totalCents).toBe(7_525);
    expect(step?.result?.breakdown).toEqual([
      { label: "Dining", cents: 5_025 },
      { label: "Transit", cents: 2_500 },
    ]);
  });

  it("takes the money field from semantics alone — a name no allowlist would guess, and no guess without one", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, app("app_declared", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "rows", tool: "host_listAccounts" }] },
    }));
    // `total` here is a COUNT that a money-name allowlist would have summed;
    // `notional` is the real money field, and no name list would ever guess it.
    const read = () => ({
      status: "ok" as const,
      output: [{ name: "Alpha", total: 3, notional: 120_000 }, { name: "Beta", total: 9, notional: 80_000 }],
    });
    const semantics = { host_listAccounts: { notional: { kind: "money", unit: "cents" } } } as const;
    const declared = (await engine(store, guardBoundRegistry([balanceTool], read), new GuardDouble(), semantics)
      .rehearse("app_declared", DEFAULT_TRIGGER_ID, ctx())).firings[0]?.steps[0];
    expect(declared?.result?.totalCents).toBe(200_000);
    // The SAME read with no synced semantics summarizes nothing at all: two
    // shared numerics and no authority on which is money, so the row carries a
    // preview and no total. It never falls back to summing `total`.
    const unsynced = (await engine(store, guardBoundRegistry([balanceTool], read))
      .rehearse("app_declared", DEFAULT_TRIGGER_ID, ctx())).firings[0]?.steps[0];
    expect(unsynced?.result).toBeUndefined();
    expect(unsynced?.preview).toContain("notional");
  });

  it("labels a breakdown with the enum's display labels, not the raw tokens", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, app("app_enum", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "rows", tool: "host_listAccounts" }] },
    }));
    const tools = guardBoundRegistry([balanceTool], () => ({
      status: "ok",
      output: { data: [{ category: "past_due", amount: 4_000 }, { category: "on_time", amount: 6_000 }] },
    }));
    // Semantics are keyed by COLLAPSED dot path, so the wrapper key counts:
    // `data.amount`, not `amount` (core semantics.ts drops array indices).
    const semantics = {
      host_listAccounts: {
        "data.amount": { kind: "money", unit: "cents" },
        "data.category": { kind: "enum", labels: { past_due: "Past due", on_time: "On time" } },
      },
    } as const;
    const step = (await engine(store, tools, new GuardDouble(), semantics)
      .rehearse("app_enum", DEFAULT_TRIGGER_ID, ctx())).firings[0]?.steps[0];
    expect(step?.result?.breakdown).toEqual([
      { label: "Past due", cents: 4_000 },
      { label: "On time", cents: 6_000 },
    ]);
  });

  it("humanizes an enum value minted since the last sync, rather than showing the raw token", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, app("app_new_enum", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "rows", tool: "host_listAccounts" }] },
    }));
    const tools = guardBoundRegistry([balanceTool], () => ({
      status: "ok",
      output: [{ category: "past_due", amount: 4_000 }, { category: "in_review", amount: 6_000 }],
    }));
    // `in_review` post-dates the sync that wrote these labels, so it is absent
    // from the map — it humanizes through core's own humanizeEnumValue, the
    // same function that produced "Past due", instead of leaking the token.
    const semantics = {
      host_listAccounts: {
        amount: { kind: "money", unit: "cents" },
        category: { kind: "enum", labels: { past_due: "Past due" } },
      },
    } as const;
    const step = (await engine(store, tools, new GuardDouble(), semantics)
      .rehearse("app_new_enum", DEFAULT_TRIGGER_ID, ctx())).firings[0]?.steps[0];
    expect(step?.result?.breakdown).toEqual([
      { label: "Past due", cents: 4_000 },
      { label: "In review", cents: 6_000 },
    ]);
  });

  it("resolves the provider form of semantics per rehearsal", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, app("app_provider", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "rows", tool: "host_listAccounts" }] },
    }));
    const tools = guardBoundRegistry([balanceTool], () => ({
      status: "ok",
      output: [{ name: "Alpha", notional: 1_500 }],
    }));
    let reads = 0;
    // The thunk form is how the umbrella passes a cloud-owned overrides.json
    // without a compose-time fetch: called during the replay, never earlier.
    const automations = engine(store, tools, new GuardDouble(), () => {
      reads += 1;
      return { host_listAccounts: { notional: { kind: "money", unit: "cents" } } };
    });
    expect(reads).toBe(0);
    const step = (await automations.rehearse("app_provider", DEFAULT_TRIGGER_ID, ctx())).firings[0]?.steps[0];
    expect(reads).toBe(1);
    expect(step?.result?.totalCents).toBe(1_500);
  });

  it("shows no headline for a money field the host's sync left unclassified", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, app("app_goals", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "rows", tool: "host_listAccounts" }] },
    }));
    const tools = guardBoundRegistry([balanceTool], () => ({
      status: "ok",
      output: [{ name: "Japan trip", saved: 312_000 }, { name: "New MacBook", saved: 90_000 }],
    }));
    // demo-bank's `Goal.saved` IS real cents, but core's MONEY_NAME regex does
    // not match it, so sync emits no semantic and rehearsal stays silent rather
    // than guessing. The honest cost of dropping the name fallback: the fix is
    // a `saved` entry in overrides.json, which corrects generation too.
    const semantics = { host_listAccounts: { id: { kind: "id" } } } as const;
    const step = (await engine(store, tools, new GuardDouble(), semantics)
      .rehearse("app_goals", DEFAULT_TRIGGER_ID, ctx())).firings[0]?.steps[0];
    expect(step?.result).toBeUndefined();
    expect(step?.preview).toContain("saved");
  });

  it("summarizes a list read into a headline total + per-item breakdown (shared numeric field only)", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_headline", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    });
    await seedApp(store, doc);
    const tools = guardBoundRegistry([balanceTool], () => ({
      status: "ok",
      output: [
        { id: "acc_checking", name: "Maple Checking", balance: 941_220, apy: 0 },
        { id: "acc_savings", name: "Maple Savings", balance: 2_814_135, apy: 4.25 },
        { id: "acc_credit", name: "Maple Credit", balance: -128_840 },
      ],
    }));
    const semantics = { host_listAccounts: { balance: { kind: "money", unit: "cents" } } } as const;
    const report = await engine(store, tools, new GuardDouble(), semantics).rehearse("app_headline", DEFAULT_TRIGGER_ID, ctx());
    const step = report.firings[0]?.steps[0];
    expect(step?.status).toBe("ok");
    // Total sums the one DECLARED money field (balance); apy is absent on Maple
    // Credit so it never shares, and labels come from the shared `name` field,
    // never a hardcoded per-tool key.
    expect(step?.result?.totalCents).toBe(941_220 + 2_814_135 - 128_840);
    expect(step?.result?.breakdown).toEqual([
      { label: "Maple Checking", cents: 941_220 },
      { label: "Maple Savings", cents: 2_814_135 },
      { label: "Maple Credit", cents: -128_840 },
    ]);
  });

  it("unwraps a { data: [...] } read and sums the shared amount, labeled by category", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_spending", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "spending", tool: "host_listAccounts" }] },
    });
    await seedApp(store, doc);
    const tools = guardBoundRegistry([balanceTool], () => ({
      status: "ok",
      output: { data: [{ category: "dining", amount: 58_720 }, { category: "transport", amount: 44_140 }] },
    }));
    // Wrapper key included, since semantics are keyed by collapsed dot path.
    const semantics = { host_listAccounts: { "data.amount": { kind: "money", unit: "cents" } } } as const;
    const step = (await engine(store, tools, new GuardDouble(), semantics)
      .rehearse("app_spending", DEFAULT_TRIGGER_ID, ctx())).firings[0]?.steps[0];
    expect(step?.result?.totalCents).toBe(58_720 + 44_140);
    // No enum semantic on `data.category`, so labels stay the raw values.
    expect(step?.result?.breakdown).toEqual([
      { label: "dining", cents: 58_720 },
      { label: "transport", cents: 44_140 },
    ]);
  });

  it("omits the headline when TWO declared money fields make the total ambiguous, but still previews it", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_ambiguous", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "rows", tool: "host_listAccounts" }] },
    });
    await seedApp(store, doc);
    const tools = guardBoundRegistry([balanceTool], () => ({
      status: "ok",
      output: [{ name: "A", debit: 100, credit: 5 }, { name: "B", debit: 200, credit: 7 }],
    }));
    // Both shared numerics are declared money, so there is no ONE field to sum
    // — ambiguity withholds the headline just as an unclassified tool does.
    const semantics = {
      host_listAccounts: {
        debit: { kind: "money", unit: "cents" },
        credit: { kind: "money", unit: "cents" },
      },
    } as const;
    const step = (await engine(store, tools, new GuardDouble(), semantics)
      .rehearse("app_ambiguous", DEFAULT_TRIGGER_ID, ctx())).firings[0]?.steps[0];
    expect(step?.result).toBeUndefined();
    // The resolved output still reaches the client through `preview` — only the
    // one-number headline is withheld, never invented.
    expect(step?.preview).toContain("debit");
  });

  it("pins date bounds to the firing's window when the tool accepts from/to; labels the rest today", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_digest", {
      on: { kind: "schedule", cron: "0 17 * * *" },
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
    const report = await automations.rehearse("app_digest", DEFAULT_TRIGGER_ID, ctx(), 7);
    const second = report.firings[1];
    expect(second?.scheduledFor).toBe("2026-07-06T17:00:00.000Z");
    const [balance, transactions] = second?.steps ?? [];
    expect(balance).toMatchObject({ status: "ok", evaluatedOn: "today" });
    expect(balance?.window).toBeUndefined();
    // Window reaches back to the PREVIOUS firing.
    expect(transactions).toMatchObject({
      status: "ok",
      evaluatedOn: "window",
      window: { from: "2026-07-05T17:00:00.000Z", to: "2026-07-06T17:00:00.000Z" },
    });
    const pinnedCall = tools.calls.find(({ call, ctx: callCtx }) =>
      call.tool === "host_listTransactions"
      && (call.args as Record<string, unknown>)["to"] === "2026-07-06T17:00:00.000Z");
    expect(pinnedCall).toBeDefined();
    expect((pinnedCall?.call.args as Record<string, unknown>)["from"]).toBe("2026-07-05T17:00:00.000Z");
    // The first firing falls back to the report window's own start.
    expect(report.firings[0]?.steps[1]?.window?.from).toBe("2026-07-05T12:00:00.000Z");
  });

  it("evaluates if-conditions per firing on the firing's event; false skips the step", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_conditional", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: {
        kind: "steps",
        steps: [{
          id: "balance",
          tool: "host_listAccounts",
          // Only fires on single-digit July days (Jul 6–9 in this window).
          if: "$contains(event.firedAt, '2026-07-0')",
        }],
      },
    });
    await seedApp(store, doc);
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    const report = await automations.rehearse("app_conditional", DEFAULT_TRIGGER_ID, ctx(), 7);
    const early = report.firings.filter((firing) => firing.scheduledFor.startsWith("2026-07-0"));
    const late = report.firings.filter((firing) => firing.scheduledFor.startsWith("2026-07-1"));
    expect(early).toHaveLength(4);
    expect(late).toHaveLength(3);
    expect(early.every((firing) => firing.status === "fired")).toBe(true);
    expect(late.every((firing) => firing.status === "skipped")).toBe(true);
    expect(late[0]?.steps[0]).toMatchObject({ status: "skipped" });
  });

  it("reports a forEach that matched nothing as a skipped step, not as an absent one", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_fanout", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: {
        kind: "steps",
        steps: [
          { id: "accounts", tool: "host_listAccounts" },
          {
            id: "alert",
            tool: "host_sendEmail",
            // No account is overdrawn in the read's output, so this matches
            // zero items on every firing.
            forEach: "[steps.accounts.accounts[balance < 0]]",
            args: { body: "'Overdrawn: ' & item.id" },
          },
        ],
      },
    });
    await seedApp(store, doc);
    const tools = guardBoundRegistry(
      [balanceTool, emailTool],
      () => ({ status: "ok", output: { accounts: [{ id: "acc_1", balance: 1500 }] } }),
    );
    const automations = engine(store, tools);
    const report = await automations.rehearse("app_fanout", DEFAULT_TRIGGER_ID, ctx(), 7);
    expect(report.firings.length).toBeGreaterThan(0);
    for (const firing of report.firings) {
      // The read still ran, so the firing fired — but the fan-out step must
      // still appear, or the report shows fewer steps than the automation has.
      expect(firing.status).toBe("fired");
      expect(firing.simulatedActions).toBe(0);
      expect(firing.steps).toHaveLength(2);
      expect(firing.steps[1]).toMatchObject({
        id: "alert",
        tool: "host_sendEmail",
        status: "skipped",
        detail: "forEach matched 0 items",
      });
    }
    expect(tools.calls.some(({ call }) => call.tool === "host_sendEmail")).toBe(false);
  });

  it("persists nothing to run history and requires no grants", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_daily", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    });
    await seedApp(store, doc);
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    const report = await automations.rehearse("app_daily", DEFAULT_TRIGGER_ID, ctx(), 7);
    expect(report.firings).toHaveLength(7);
    expect((await store.records("vendo_runs").list({})).records).toHaveLength(0);
    expect((await store.records("vendo_grants").list({})).records).toHaveLength(0);
    expect((await store.records("vendo_approvals").list({})).records).toHaveLength(0);
  });

  it("a blocked call stops the firing with an error row; later firings still rehearse", async () => {
    const store = memoryStoreAdapter();
    const doc = app("app_blocked", {
      on: { kind: "schedule", cron: "0 8 * * *" },
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
    const report = await automations.rehearse("app_blocked", DEFAULT_TRIGGER_ID, ctx());
    expect(report.firings[0]).toMatchObject({ status: "error" });
    expect(report.firings[0]?.steps[0]).toMatchObject({ status: "blocked", detail: "not now" });
    expect(report.firings.slice(1).every((firing) => firing.status === "fired")).toBe(true);
  });
});

describe("rehearse() window selection", () => {
  const dailyApp = () => app("app_daily", {
    on: { kind: "schedule", cron: "0 8 * * *" },
    run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
  });

  it("defaults to a 30-day window when no window is given", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, dailyApp());
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    const report = await automations.rehearse("app_daily", DEFAULT_TRIGGER_ID, ctx());
    expect(report.windowDays).toBe(30);
    // NOW − 30 days.
    expect(report.from).toBe("2026-06-12T12:00:00.000Z");
    expect(report.to).toBe("2026-07-12T12:00:00.000Z");
  });

  it("honours explicit 7 and 30 windows, which resolve different `from` bounds", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, dailyApp());
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    const week = await automations.rehearse("app_daily", DEFAULT_TRIGGER_ID, ctx(), 7);
    const month = await automations.rehearse("app_daily", DEFAULT_TRIGGER_ID, ctx(), 30);
    expect(week.windowDays).toBe(7);
    expect(month.windowDays).toBe(30);
    expect(week.from).toBe("2026-07-05T12:00:00.000Z");
    expect(month.from).toBe("2026-06-12T12:00:00.000Z");
    expect(week.from).not.toBe(month.from);
    // The wider window enumerates strictly more firings for the same schedule.
    expect(month.firings.length).toBeGreaterThan(week.firings.length);
  });
});

describe("rehearse() server-side cooldown", () => {
  const dailyApp = () => app("app_daily", {
    on: { kind: "schedule", cron: "0 8 * * *" },
    run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
  });

  const clockedEngine = (store: StoreAdapter, clock: { ms: number }) => createAutomations({
    apps: { call: async () => ({ status: "ok", output: {} }) } as never,
    tools: guardBoundRegistry([balanceTool]),
    guard: new GuardDouble(),
    store,
    now: () => new Date(clock.ms),
  });

  it("rejects a repeat of the same app+window in quick succession, then clears after the cooldown", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, dailyApp());
    const clock = { ms: NOW.getTime() };
    const automations = clockedEngine(store, clock);
    // First replay runs.
    await expect(automations.rehearse("app_daily", DEFAULT_TRIGGER_ID, ctx(), 30)).resolves.toBeDefined();
    // An immediate repeat of the SAME window is a clear error, not a silent no-op.
    await expect(automations.rehearse("app_daily", DEFAULT_TRIGGER_ID, ctx(), 30)).rejects.toThrow(/cooling down/);
    // Once the cooldown elapses, the same window is allowed again.
    clock.ms += 3_000;
    await expect(automations.rehearse("app_daily", DEFAULT_TRIGGER_ID, ctx(), 30)).resolves.toBeDefined();
  });

  it("does NOT throttle a legitimate 7d/30d toggle in the same instant (keyed per window)", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, dailyApp());
    const clock = { ms: NOW.getTime() };
    const automations = clockedEngine(store, clock);
    await expect(automations.rehearse("app_daily", DEFAULT_TRIGGER_ID, ctx(), 30)).resolves.toBeDefined();
    // Toggling to the other window immediately is fine — different key.
    await expect(automations.rehearse("app_daily", DEFAULT_TRIGGER_ID, ctx(), 7)).resolves.toBeDefined();
    // But re-clicking the SAME window is still throttled.
    await expect(automations.rehearse("app_daily", DEFAULT_TRIGGER_ID, ctx(), 7)).rejects.toThrow(/cooling down/);
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
    await expect(automations.rehearse("app_event", DEFAULT_TRIGGER_ID, ctx())).rejects.toThrow(VendoError);
    await expect(automations.rehearse("app_event", DEFAULT_TRIGGER_ID, ctx())).rejects.toThrow(/schedule triggers only/);
    await expect(automations.rehearse("app_agentic", DEFAULT_TRIGGER_ID, ctx())).rejects.toThrow(/steps automations only/);
  });

  it("is owner-scoped: a foreign subject gets not-found", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, app("app_daily", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "balance", tool: "host_listAccounts" }] },
    }));
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    await expect(automations.rehearse("app_daily", DEFAULT_TRIGGER_ID, ctx("user_b"))).rejects.toThrow(/not found/);
  });

  it("rejects an unknown tool up front", async () => {
    const store = memoryStoreAdapter();
    await seedApp(store, app("app_unknown", {
      on: { kind: "schedule", cron: "0 8 * * *" },
      run: { kind: "steps", steps: [{ id: "x", tool: "host_missing" }] },
    }));
    const automations = engine(store, guardBoundRegistry([balanceTool]));
    await expect(automations.rehearse("app_unknown", DEFAULT_TRIGGER_ID, ctx())).rejects.toThrow(/unknown tool/);
  });
});
