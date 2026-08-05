#!/usr/bin/env node
/**
 * Console seeding — populates the surfaces the Vendo console reads so the
 * automations and guard pages are non-empty for the Maple tenant. Bank data
 * itself needs no script (src/server/seed.ts rebuilds it deterministically at
 * boot), and the scripted-demo rows are seedDemoScript's; this script adds,
 * per seeded Maple user:
 *
 * - six automations (`vendo_apps`) — four enabled (payday savings sweep,
 *   balance-below-$500 alert, monthly bill review, weekly spending digest)
 *   and two disabled (subscription price watch, quarterly tax set-aside);
 * - ~6 weeks of run history (`vendo_runs`) — mostly ok, a few failures — so
 *   the automations page shows a lived-in fire record;
 * - ~100 audit events per user (`vendo_audit`) — chat/automation/mcp tool
 *   calls, approvals granted and denied, and one org-blocked MCP transfer;
 * - the org guard policy at /orgs/maple/policy.json (LOCAL store only — the
 *   workspace door needs a SQL handle; on the hosted store the console owns
 *   that file).
 *
 * Everything rides the PUBLIC records door (`store.records(...)` — the
 * reserved-collection routing every VendoStore implements), the same mechanism
 * as src/demo-script/seed.ts, so it behaves identically on the local PGlite
 * store and the Cloud hosted store. Idempotent: insert-if-absent, never
 * clobbers an existing row.
 *
 * Usage (from examples/demo-bank; stop the dev server first — PGlite is
 * single-writer):
 *   pnpm seed:console                          # local .vendo/data (MAPLE_STORE=local posture)
 *   pnpm seed:console -- --data-dir /tmp/x     # local, elsewhere
 *   pnpm seed:console -- --cloud               # Yousef's Cloud tenant (needs VENDO_API_KEY)
 *
 * NOT seedable from here (no public API in this repo):
 * - usage/metering charts — metered server-side by the console when the model
 *   gateway / tools / sandboxes are hit (pricing-oss unmerged); the honest way
 *   to fill them is running real agent turns against the tenant;
 * - the org guard policy on the HOSTED store — console-managed (guard PR 789).
 */
import type { AppDocument, AppId, AuditEvent, RunId } from "@vendoai/core";
import { workspaceStore, type VendoStore } from "@vendoai/store";
import { mapleDemoUsers } from "@/server/users";

const ORG = "maple";

function iso(d: Date): string { return d.toISOString(); }
function daysAgo(anchor: Date, n: number, h = 9, m = 0): Date {
  const d = new Date(anchor); d.setDate(d.getDate() - n); d.setHours(h, m, 0, 0); return d;
}

// ---------------------------------------------------------------- automations

function seedId(key: string, subject: string): string {
  return `app_seed_${key}_${subject}`;
}

/** The seeded automations — the doc plus whether the row is enabled, so the
 *  list shows a couple of paused ones the way a real tenant's would. */
function automationSeeds(subject: string): { doc: AppDocument; enabled: boolean }[] {
  return automationDocs(subject).map((doc) => ({
    doc,
    enabled: !DISABLED_KEYS.some((key) => doc.id === seedId(key, subject)),
  }));
}

const DISABLED_KEYS = ["pricewatch", "taxsetaside"];

function automationDocs(subject: string): AppDocument[] {
  return [
    {
      format: "vendo/app@1",
      id: seedId("paydaysweep", subject) as AppId,
      name: "Payday savings sweep",
      description: "On the 1st and 15th at 9:00 AM, move $200 from Maple Checking to Maple Savings.",
      trigger: {
        on: { kind: "schedule", cron: "0 9 1,15 * *" },
        run: {
          kind: "agentic",
          prompt: "Move $200.00 from Maple Checking to Maple Savings and confirm the transfer posted.",
          budget: { maxToolCalls: 5 },
        },
      },
    },
    {
      format: "vendo/app@1",
      id: seedId("lowbalance500", subject) as AppId,
      name: "Balance below $500 alert",
      description: "Every morning at 7:00 AM, check Maple Checking and draft an alert if the available balance is below $500.",
      trigger: {
        on: { kind: "schedule", cron: "0 7 * * *" },
        run: {
          kind: "steps",
          steps: [{ id: "balance", tool: "host_listAccounts" }],
        },
      },
    },
    {
      format: "vendo/app@1",
      id: seedId("billreview", subject) as AppId,
      name: "Monthly bill review",
      description: "On the 28th at 9:00 AM, review upcoming bills and recurring subscriptions and prepare a summary.",
      trigger: {
        on: { kind: "schedule", cron: "0 9 28 * *" },
        run: {
          kind: "steps",
          steps: [
            { id: "scheduled", tool: "host_listScheduledPayments" },
            { id: "recurring", tool: "host_getRecurringInsights" },
          ],
        },
      },
    },
    {
      format: "vendo/app@1",
      id: seedId("weeklydigest", subject) as AppId,
      name: "Weekly spending digest",
      description: "Every Monday at 8:00 AM, summarize last week's spending by category and how cashflow is trending.",
      trigger: {
        on: { kind: "schedule", cron: "0 8 * * 1" },
        run: {
          kind: "steps",
          steps: [
            { id: "spending", tool: "host_getSpendingInsights" },
            { id: "cashflow", tool: "host_getCashflowInsights" },
          ],
        },
      },
    },
    {
      format: "vendo/app@1",
      id: seedId("pricewatch", subject) as AppId,
      name: "Subscription price watch",
      description: "On the 5th at 10:00 AM, flag any subscription that got more expensive month-over-month. (Paused.)",
      trigger: {
        on: { kind: "schedule", cron: "0 10 5 * *" },
        run: {
          kind: "steps",
          steps: [{ id: "recurring", tool: "host_getRecurringInsights" }],
        },
      },
    },
    {
      format: "vendo/app@1",
      id: seedId("taxsetaside", subject) as AppId,
      name: "Quarterly tax set-aside",
      description: "Quarterly on the 1st at 9:00 AM, move 25% of the quarter's business income into Maple Money Market. (Paused.)",
      trigger: {
        on: { kind: "schedule", cron: "0 9 1 */3 *" },
        run: {
          kind: "agentic",
          prompt: "Total this quarter's Maple Business Checking income, move 25% of it to Maple Money Market, and confirm the transfer posted.",
          budget: { maxToolCalls: 8 },
        },
      },
    },
  ];
}

async function seedAutomations(store: VendoStore, subjects: string[]): Promise<number> {
  const apps = store.records("vendo_apps");
  let written = 0;
  for (const subject of subjects) {
    for (const { doc, enabled } of automationSeeds(subject)) {
      if (await apps.get(doc.id) !== null) continue;
      await apps.put({ id: doc.id, data: { subject, enabled, doc } });
      written++;
    }
  }
  return written;
}

// ---------------------------------------------------------------- run history

interface SeedRun {
  id: string;
  appId: string;
  startedAt: Date;
  durationS: number;
  steps: { id: string; tool: string }[];
  summary: string;
  /** Absent means "ok"; present means the run errored with this message. */
  failure?: string;
}

/** ~6 weeks of believable fires per user, matching each automation's cadence —
 *  mostly clean, with the occasional failure a real fire record has. */
function runHistory(subject: string, anchor: Date): SeedRun[] {
  const runs: SeedRun[] = [];
  const sweep = seedId("paydaysweep", subject);
  for (const [n, day] of [[1, 3], [2, 17], [3, 31]] as const) {
    runs.push({
      id: `run_seed_sweep_${n}_${subject}`, appId: sweep,
      startedAt: daysAgo(anchor, day, 9, 0), durationS: 8,
      steps: [{ id: "transfer", tool: "host_transferMoney" }],
      summary: "Moved $200.00 from Maple Checking to Maple Savings.",
    });
  }
  const alert = seedId("lowbalance500", subject);
  const alertFailures = new Set([13, 27]);
  for (let day = 1; day <= 41; day += 2) {
    runs.push({
      id: `run_seed_alert_${day}_${subject}`, appId: alert,
      startedAt: daysAgo(anchor, day, 7, 0), durationS: 3,
      steps: [{ id: "balance", tool: "host_listAccounts" }],
      summary: "Maple Checking is at $9,412.20 — above the $500 threshold, no alert needed.",
      ...(alertFailures.has(day) ? { failure: "Maple API timed out fetching accounts." } : {}),
    });
  }
  for (const [n, day] of [[1, 8], [2, 38]] as const) {
    runs.push({
      id: `run_seed_bills_${n}_${subject}`, appId: seedId("billreview", subject),
      startedAt: daysAgo(anchor, day, 9, 0), durationS: 6,
      steps: [
        { id: "scheduled", tool: "host_listScheduledPayments" },
        { id: "recurring", tool: "host_getRecurringInsights" },
      ],
      summary: "6 bills upcoming ($5,790.59) and 10 active subscriptions ($485.41/mo); nothing overdue.",
    });
  }
  const digest = seedId("weeklydigest", subject);
  for (const day of [2, 9, 16, 23, 30, 37]) {
    runs.push({
      id: `run_seed_digest_${day}_${subject}`, appId: digest,
      startedAt: daysAgo(anchor, day, 8, 0), durationS: 5,
      steps: [
        { id: "spending", tool: "host_getSpendingInsights" },
        { id: "cashflow", tool: "host_getCashflowInsights" },
      ],
      summary: "Spent $2,184.63 last week — dining up 18%, groceries flat; cashflow positive.",
      ...(day === 23 ? { failure: "Insights endpoint returned 503; digest skipped." } : {}),
    });
  }
  return runs;
}

async function seedRuns(store: VendoStore, subjects: string[], anchor: Date): Promise<number> {
  const table = store.records("vendo_runs");
  let written = 0;
  for (const subject of subjects) {
    for (const run of runHistory(subject, anchor)) {
      if (await table.get(run.id) !== null) continue;
      const startedAt = iso(run.startedAt);
      const finishedAt = iso(new Date(run.startedAt.getTime() + run.durationS * 1000));
      const status = run.failure === undefined ? ("ok" as const) : ("error" as const);
      const outcome = run.failure === undefined ? ("ok" as const) : ("error" as const);
      const record = {
        id: run.id, appId: run.appId,
        trigger: { kind: "schedule" as const },
        status, startedAt, finishedAt,
        steps: run.steps.map((step, index) => ({
          ...step, outcome,
          at: iso(new Date(run.startedAt.getTime() + (index + 1) * 1000)),
        })),
        ...(run.failure === undefined
          ? { summary: run.summary }
          : { error: { code: "host-error", message: run.failure } }),
      };
      await table.put({
        id: run.id,
        data: { appId: run.appId, trigger: { kind: "schedule" }, status, record, startedAt, finishedAt },
      });
      written++;
    }
  }
  return written;
}

// ------------------------------------------------------------- agent activity

/** Audit trail matching the run history plus everyday chat activity, so the
 *  console's activity surfaces have ~6 weeks (~100 rows per user) of varied
 *  history. decidedBy stays within the hosted-store mirror's accepted set. */
function auditEvents(subject: string, anchor: Date): AuditEvent[] {
  const events: AuditEvent[] = [];
  let n = 0;
  const add = (at: Date, event: Omit<AuditEvent, "id" | "at" | "principal">): void => {
    events.push({
      id: `aud_seed_${String(++n).padStart(3, "0")}_${subject}`,
      at: iso(at), principal: { kind: "user", subject }, ...event,
    });
  };

  // Every automation fire leaves a run event + its tool calls, away.
  for (const run of runHistory(subject, anchor)) {
    const trigger = { runId: run.id as RunId, kind: "schedule" as const };
    const outcome = run.failure === undefined ? ("ok" as const) : ("error" as const);
    add(run.startedAt, {
      kind: "run", venue: "automation", presence: "away",
      appId: run.appId as AppId, trigger, outcome,
    });
    for (const step of run.steps) {
      add(new Date(run.startedAt.getTime() + 1000), {
        kind: "tool-call", venue: "automation", presence: "away",
        appId: run.appId as AppId, trigger,
        tool: step.tool, outcome, decidedBy: "grant",
      });
    }
  }

  // Everyday chat reads, present, auto-run by the host policy's read rule —
  // with the occasional grant-, judge- and default-decided call mixed in.
  const chat: [number, number, string, AuditEvent["decidedBy"]][] = [
    [1, 21, "host_listTransactions", "rule"], [2, 19, "host_listTransactions", "rule"],
    [2, 19, "host_getSpendingInsights", "rule"], [4, 9, "host_listCards", "grant"],
    [5, 12, "host_listAccounts", "rule"], [6, 15, "host_getBudgets", "rule"],
    [8, 10, "host_listScheduledPayments", "judge"], [9, 20, "host_getCashflowInsights", "rule"],
    [11, 14, "host_listTransactions", "rule"], [12, 8, "host_listTransactions", "rule"],
    [14, 17, "host_getRecurringInsights", "grant"], [16, 13, "host_getBudgets", "rule"],
    [19, 18, "host_listGoals", "rule"], [22, 11, "host_listAccounts", "default"],
    [25, 16, "host_getSpendingInsights", "rule"], [28, 9, "host_listTransactions", "rule"],
    [31, 19, "host_getCashflowInsights", "rule"], [34, 12, "host_listPayees", "rule"],
    [37, 15, "host_listTransactions", "rule"], [40, 10, "host_getRecurringInsights", "rule"],
  ];
  for (const [day, hour, tool, decidedBy] of chat) {
    add(daysAgo(anchor, day, hour, 24), {
      kind: "tool-call", venue: "chat", presence: "present",
      tool, outcome: "ok", decidedBy,
    });
  }

  // Two transfers asked about in chat and approved by the user...
  add(daysAgo(anchor, 4, 11, 3), {
    kind: "tool-call", venue: "chat", presence: "present",
    tool: "host_transferMoney", inputPreview: "$150.00 Checking → Savings",
    outcome: "pending-approval", decidedBy: "rule",
  });
  add(daysAgo(anchor, 4, 11, 4), {
    kind: "approval", venue: "chat", presence: "present",
    tool: "host_transferMoney", outcome: "ok",
  });
  add(daysAgo(anchor, 20, 13, 12), {
    kind: "tool-call", venue: "chat", presence: "present",
    tool: "host_payBill", inputPreview: "$86.40 PG&E from Checking",
    outcome: "pending-approval", decidedBy: "rule",
  });
  add(daysAgo(anchor, 20, 13, 13), {
    kind: "approval", venue: "chat", presence: "present",
    tool: "host_payBill", outcome: "ok",
  });
  // ...one the user looked at and declined...
  add(daysAgo(anchor, 13, 18, 47), {
    kind: "tool-call", venue: "chat", presence: "present",
    tool: "host_transferMoney", inputPreview: "$2,000.00 Savings → Checking",
    outcome: "pending-approval", decidedBy: "rule",
  });
  add(daysAgo(anchor, 13, 18, 49), {
    kind: "approval", venue: "chat", presence: "present",
    tool: "host_transferMoney", inputPreview: "$2,000.00 Savings → Checking",
    outcome: "blocked",
  });
  // ...and one MCP transfer the org policy blocks (see /orgs/maple/policy.json).
  add(daysAgo(anchor, 3, 15, 41), {
    kind: "tool-call", venue: "mcp", presence: "away",
    tool: "host_transferMoney", inputPreview: "$900.00 Checking → external",
    // "org" is truer, but the hosted store's schema mirror predates that
    // enum member and rejects it — "rule" validates on both sides.
    outcome: "blocked", decidedBy: "rule",
  });
  return events;
}

async function seedAudit(store: VendoStore, subjects: string[], anchor: Date): Promise<number> {
  const table = store.records("vendo_audit"); // append-only door
  let written = 0;
  for (const subject of subjects) {
    for (const event of auditEvents(subject, anchor)) {
      if (await table.get(event.id) !== null) continue;
      await table.put({ id: event.id, data: event });
      written++;
    }
  }
  return written;
}

// ------------------------------------------------------------ org guard policy

const ORG_POLICY = {
  format: "vendo/org-policy@1",
  rules: [
    { match: { risk: "destructive" }, action: "ask", note: "Every destructive action needs an explicit yes, org-wide." },
    { match: { tool: "host_transferMoney", venue: "mcp" }, action: "block", note: "Money never moves on behalf of an external MCP client." },
    { match: { risk: "write", venue: "mcp" }, action: "ask", note: "External MCP clients confirm every write in-product." },
  ],
};

/** Local stores only: the workspace door needs a SQL handle the hosted store
 *  has not got — on Cloud this file is the console's (guard PR 789). */
async function seedOrgPolicy(store: VendoStore, adminSubject: string): Promise<string> {
  const path = `/orgs/${ORG}/policy.json`;
  let fs;
  try {
    fs = await workspaceStore(store).open(
      { kind: "user", subject: adminSubject },
      { memberships: [{ org: ORG, admin: true }] },
    );
  } catch {
    return `skipped ${path} — no workspace on this store (hosted); the console manages org policy (guard PR 789)`;
  }
  if (await fs.exists(path)) return `kept existing ${path}`;
  await fs.writeFile(path, `${JSON.stringify(ORG_POLICY, null, 2)}\n`);
  const outcome = await fs.commit();
  if (outcome.status !== "ok") throw new Error(`org policy commit failed: ${JSON.stringify(outcome)}`);
  return `wrote ${path} (${ORG_POLICY.rules.length} rules)`;
}

// --------------------------------------------------------------- entry point

export interface ConsoleSeedTotals {
  automations: number;
  runs: number;
  audit: number;
  orgPolicy: string;
}

/** Seed everything the console reads, through the given store's public doors.
 *  Idempotent; safe on every boot and after /api/demo/reset. */
export async function seedConsoleData(store: VendoStore, anchor: Date = new Date()): Promise<ConsoleSeedTotals> {
  const subjects = mapleDemoUsers().map((user) => user.subject);
  await store.ensureSchema();
  return {
    automations: await seedAutomations(store, subjects),
    runs: await seedRuns(store, subjects, anchor),
    audit: await seedAudit(store, subjects, anchor),
    orgPolicy: await seedOrgPolicy(store, subjects[0] ?? "vendo-demo"),
  };
}
