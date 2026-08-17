/**
 * Scripted-demo seeding — idempotent. Runs at server boot (instrumentation.ts)
 * and again after /api/demo/reset, so the demo always starts scripted-ready:
 *
 * - the two fixture microapps ("Spending This Month", "Money HQ") exist for
 *   every seeded Maple user under DETERMINISTIC app ids the scripted turn
 *   engine references;
 * - the "Weekly spending summary" and "Low balance alert" automation
 *   RECORDS exist DISARMED (the "Email me a weekly summary" and "Alert me
 *   before I overdraft" beats enable them through the real automations
 *   engine, surfacing the standing-grant asks in-thread).
 *
 * Existing rows are left untouched (a user's recorded pins survive), so
 * seeding is safe to run on every boot.
 */
import type { AppDocument, AutomationRecord, AutomationTask, TriggerSource } from "@vendoai/core";
import { mapleDemoUsers } from "@/server/users";
import { vendo } from "@/vendo/server";
import { seedConsoleData } from "./console-seed";
import moneyHqFixture from "./fixtures/money-hq.json";
import spendingFixture from "./fixtures/spending-breakdown.json";

/** The two automations the scripted beats arm. */
export type DemoAutomationKey = "weekly" | "lowbalance";

/** Deterministic per-user app ids (app row ids are global, one subject each). */
export function demoAppId(key: "spending" | "moneyhq", subject: string): string {
  return `app_demo_${key}_${subject}`;
}

/** The same, for the automation RECORDS — a different table and a different
 *  unit, so a different id space. */
export function demoAutomationId(key: DemoAutomationKey, subject: string): string {
  return `atm_demo_${key}_${subject}`;
}

/** A record is an owner, a trigger and a task — it holds no name and no
 *  description. The words the thread's automation card shows are Maple's own,
 *  so Maple keeps them here beside the records they describe. */
export const demoAutomationDisplay: Record<DemoAutomationKey, { name: string; description: string }> = {
  weekly: {
    name: "Weekly spending summary",
    description:
      "Every Friday at 5:00 PM, prepare a digest of that week's spending by category, drafted and ready for you to send.",
  },
  lowbalance: {
    name: "Low balance alert",
    description:
      "Every morning at 8:00 AM, check Maple Checking and draft an alert if the balance is below $2,000, ready for you to send.",
  },
};

function automationRecord(
  key: DemoAutomationKey,
  subject: string,
  when: TriggerSource,
  task: AutomationTask,
): AutomationRecord {
  const at = new Date().toISOString();
  return {
    id: demoAutomationId(key, subject),
    owner: { kind: "user", subject },
    when,
    task,
    // The beats arm it: it exists so the scripted enable() has something real
    // to turn on, and its standing-grant asks to surface in-thread.
    armed: false,
    authoredBy: "chat",
    createdAt: at,
    updatedAt: at,
  };
}

function demoAutomations(subject: string): AutomationRecord[] {
  return [
    automationRecord("weekly", subject, { kind: "schedule", cron: "0 17 * * 5" }, {
      // A steps task: the capture surface stays exactly these host reads (a
      // goal task would conservatively capture EVERY bound tool).
      kind: "steps",
      steps: [
        { id: "spending", tool: "host_getSpendingInsights" },
        { id: "transactions", tool: "host_listTransactions" },
      ],
    }),
    automationRecord("lowbalance", subject, { kind: "schedule", cron: "0 8 * * *" }, {
      // One host read keeps the standing-grant surface to a single consent
      // moment in the scripted beat (the email is the delivery story, exactly
      // like the weekly digest above).
      kind: "steps",
      steps: [{ id: "balance", tool: "host_listAccounts" }],
    }),
  ];
}

function fixtureDocument(fixture: unknown, id: string): AppDocument {
  return { ...(fixture as Omit<AppDocument, "id">), id, format: "vendo/app@1" };
}

/** Insert-if-absent all scripted-demo rows for every seeded Maple user.
 *  Store-agnostic on purpose: writes ride the PUBLIC records door
 *  (`store.records(...)` — the reserved-collection routing every VendoStore
 *  implements), so seeding behaves identically on the local PGlite store and
 *  the Cloud hosted store. */
export async function seedDemoScript(): Promise<void> {
  await vendo.store.ensureSchema();
  const apps = vendo.store.records("vendo_apps");
  const automations = vendo.store.records("vendo_automations");
  for (const user of mapleDemoUsers()) {
    const docs = [
      fixtureDocument(spendingFixture, demoAppId("spending", user.subject)),
      fixtureDocument(moneyHqFixture, demoAppId("moneyhq", user.subject)),
    ];
    for (const doc of docs) {
      const existing = await apps.get(doc.id);
      if (existing !== null) continue; // never clobber recorded pins/edits
      await apps.put({ id: doc.id, data: { subject: user.subject, enabled: false, doc } });
    }
    for (const record of demoAutomations(user.subject)) {
      if (await automations.get(record.id) !== null) continue; // never re-disarm one they armed
      await automations.put({ id: record.id, data: record, refs: { subject: user.subject } });
    }
  }
  await seedConsoleData(vendo.store);
}
