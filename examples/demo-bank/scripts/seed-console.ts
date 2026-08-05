#!/usr/bin/env node
/**
 * Console seeding — populates the surfaces the Vendo console reads so the
 * automations and guard pages are non-empty for the Maple tenant. Bank data
 * itself needs no script (src/server/seed.ts rebuilds it deterministically at
 * boot), and the scripted-demo rows are seedDemoScript's; this script adds,
 * per seeded Maple user:
 *
 * - three ENABLED automations (`vendo_apps`) — payday savings sweep,
 *   balance-below-$500 alert, monthly bill review;
 * - ~3 weeks of run history (`vendo_runs`) so the automations page shows fires;
 * - ~3 weeks of audit events (`vendo_audit`) — chat/automation/mcp tool calls,
 *   an approval, and one org-blocked MCP transfer;
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
import { fileURLToPath } from "node:url";
import type { AppDocument, AppId, AuditEvent, RunId } from "@vendoai/core";
import { createStore, workspaceStore, type VendoStore } from "@vendoai/store";
import { mapleDemoUsers } from "../src/server/users";

const ORG = "maple";

function iso(d: Date): string { return d.toISOString(); }
function daysAgo(anchor: Date, n: number, h = 9, m = 0): Date {
  const d = new Date(anchor); d.setDate(d.getDate() - n); d.setHours(h, m, 0, 0); return d;
}

// ---------------------------------------------------------------- automations

function seedId(key: string, subject: string): string {
  return `app_seed_${key}_${subject}`;
}

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
  ];
}

async function seedAutomations(store: VendoStore, subjects: string[]): Promise<number> {
  const apps = store.records("vendo_apps");
  let written = 0;
  for (const subject of subjects) {
    for (const doc of automationDocs(subject)) {
      if (await apps.get(doc.id) !== null) continue;
      await apps.put({ id: doc.id, data: { subject, enabled: true, doc } });
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
}

/** ~3 weeks of believable fires per user, matching each automation's cadence. */
function runHistory(subject: string, anchor: Date): SeedRun[] {
  const runs: SeedRun[] = [];
  const sweep = seedId("paydaysweep", subject);
  for (const [n, day] of [[1, 6], [2, 20]] as const) {
    runs.push({
      id: `run_seed_sweep_${n}_${subject}`, appId: sweep,
      startedAt: daysAgo(anchor, day, 9, 0), durationS: 8,
      steps: [{ id: "transfer", tool: "host_transferMoney" }],
      summary: "Moved $200.00 from Maple Checking to Maple Savings.",
    });
  }
  const alert = seedId("lowbalance500", subject);
  for (let day = 1; day <= 21; day += 2) {
    runs.push({
      id: `run_seed_alert_${day}_${subject}`, appId: alert,
      startedAt: daysAgo(anchor, day, 7, 0), durationS: 3,
      steps: [{ id: "balance", tool: "host_listAccounts" }],
      summary: "Maple Checking is at $9,412.20 — above the $500 threshold, no alert needed.",
    });
  }
  runs.push({
    id: `run_seed_bills_1_${subject}`, appId: seedId("billreview", subject),
    startedAt: daysAgo(anchor, 8, 9, 0), durationS: 6,
    steps: [
      { id: "scheduled", tool: "host_listScheduledPayments" },
      { id: "recurring", tool: "host_getRecurringInsights" },
    ],
    summary: "2 bills upcoming ($2,936.40) and 6 active subscriptions ($345.47/mo); nothing overdue.",
  });
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
      const record = {
        id: run.id, appId: run.appId,
        trigger: { kind: "schedule" as const },
        status: "ok" as const, startedAt, finishedAt,
        steps: run.steps.map((step, index) => ({
          ...step, outcome: "ok" as const,
          at: iso(new Date(run.startedAt.getTime() + (index + 1) * 1000)),
        })),
        summary: run.summary,
      };
      await table.put({
        id: run.id,
        data: { appId: run.appId, trigger: { kind: "schedule" }, status: "ok", record, startedAt, finishedAt },
      });
      written++;
    }
  }
  return written;
}

// ------------------------------------------------------------- agent activity

/** Audit trail matching the run history plus everyday chat activity, so the
 *  console's activity surfaces have ~3 weeks of varied rows. */
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
    add(run.startedAt, {
      kind: "run", venue: "automation", presence: "away",
      appId: run.appId as AppId, trigger, outcome: "ok",
    });
    for (const step of run.steps) {
      add(new Date(run.startedAt.getTime() + 1000), {
        kind: "tool-call", venue: "automation", presence: "away",
        appId: run.appId as AppId, trigger,
        tool: step.tool, outcome: "ok", decidedBy: "grant",
      });
    }
  }

  // Everyday chat reads, present, allowed by the host policy's read rule.
  const chat: [number, number, string][] = [
    [2, 19, "host_listTransactions"], [2, 19, "host_getSpendingInsights"],
    [5, 12, "host_listAccounts"], [9, 20, "host_getCashflowInsights"],
    [12, 8, "host_listTransactions"], [16, 13, "host_getBudgets"],
    [19, 18, "host_listGoals"],
  ];
  for (const [day, hour, tool] of chat) {
    add(daysAgo(anchor, day, hour, 24), {
      kind: "tool-call", venue: "chat", presence: "present",
      tool, outcome: "ok", decidedBy: "rule",
    });
  }

  // A transfer asked about in chat and approved by the user...
  add(daysAgo(anchor, 4, 11, 3), {
    kind: "tool-call", venue: "chat", presence: "present",
    tool: "host_transferMoney", inputPreview: "$150.00 Checking → Savings",
    outcome: "pending-approval", decidedBy: "rule",
  });
  add(daysAgo(anchor, 4, 11, 4), {
    kind: "approval", venue: "chat", presence: "present",
    tool: "host_transferMoney", outcome: "ok",
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

// ------------------------------------------------------------------------ main

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const cloud = args.includes("--cloud");
  const dataDirFlag = args.indexOf("--data-dir");
  const dataDir = dataDirFlag === -1
    ? fileURLToPath(new URL("../.vendo/data", import.meta.url))
    : args[dataDirFlag + 1];
  if (dataDir === undefined) throw new Error("--data-dir needs a path");

  let store: VendoStore;
  if (cloud) {
    const apiKey = process.env.VENDO_API_KEY;
    if (!apiKey) throw new Error("--cloud needs VENDO_API_KEY (Yousef's Vendo Cloud key)");
    const { hostedStore } = await import("@vendoai/vendo/server");
    const baseUrl = process.env.VENDO_CLOUD_URL;
    store = hostedStore({ apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) });
    console.log(`Seeding the Vendo Cloud HOSTED store${baseUrl === undefined ? "" : ` at ${baseUrl}`} — this writes into the live tenant.`);
  } else {
    store = createStore({ dataDir });
    console.log(`Seeding the local PGlite store at ${dataDir} (stop the dev server first — single writer).`);
  }

  const anchor = new Date();
  const subjects = mapleDemoUsers().map((user) => user.subject);
  try {
    await store.ensureSchema();
    console.log(`automations: ${await seedAutomations(store, subjects)} written (${subjects.length} users)`);
    console.log(`run history: ${await seedRuns(store, subjects, anchor)} written`);
    console.log(`audit trail: ${await seedAudit(store, subjects, anchor)} written`);
    console.log(`org policy:  ${await seedOrgPolicy(store, subjects[0] ?? "vendo-demo")}`);
    console.log(
      "usage/metering: nothing to seed — the console meters model-gateway/tool/sandbox traffic "
      + "server-side (pricing-oss unmerged); run real agent turns against the tenant to fill the charts.",
    );
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
