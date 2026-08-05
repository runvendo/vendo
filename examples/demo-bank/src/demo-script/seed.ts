/**
 * Scripted-demo seeding — idempotent. Runs at server boot (instrumentation.ts)
 * and again after /api/demo/reset, so the demo always starts scripted-ready:
 *
 * - the two fixture microapps ("Spending This Month", "Money HQ") exist for
 *   every seeded Maple user under DETERMINISTIC app ids the scripted turn
 *   engine references;
 * - the "Weekly spending summary" and "Low balance alert" automation
 *   documents exist DISABLED (the "Email me a weekly summary" and "Alert me
 *   before I overdraft" beats enable them through the real automations
 *   engine, surfacing the standing-grant asks in-thread).
 *
 * Existing rows are left untouched (a user's recorded pins survive), so
 * seeding is safe to run on every boot.
 */
import type { AppDocument } from "@vendoai/core";
import { mapleDemoUsers } from "@/server/users";
import { vendo } from "@/vendo/server";
import { seedConsoleData } from "./console-seed";
import moneyHqFixture from "./fixtures/money-hq.json";
import spendingFixture from "./fixtures/spending-breakdown.json";

/** Deterministic per-user app ids (app row ids are global, one subject each). */
export function demoAppId(key: "spending" | "moneyhq" | "weekly" | "lowbalance", subject: string): string {
  return `app_demo_${key}_${subject}`;
}

function weeklySummaryDocument(id: string): AppDocument {
  return {
    format: "vendo/app@1",
    id,
    name: "Weekly spending summary",
    description:
      "Every Friday at 5:00 PM, prepare a digest of that week's spending by category, drafted and ready for you to send.",
    trigger: {
      on: { kind: "schedule", cron: "0 17 * * 5" },
      // Steps run model: the capture surface stays exactly these host reads
      // (an agentic run would conservatively capture EVERY bound tool).
      run: {
        kind: "steps",
        steps: [
          { id: "spending", tool: "host_getSpendingInsights" },
          { id: "transactions", tool: "host_listTransactions" },
        ],
      },
    },
  };
}

function lowBalanceAlertDocument(id: string): AppDocument {
  return {
    format: "vendo/app@1",
    id,
    name: "Low balance alert",
    description:
      "Every morning at 8:00 AM, check Maple Checking and draft an alert if the balance is below $2,000, ready for you to send.",
    trigger: {
      on: { kind: "schedule", cron: "0 8 * * *" },
      // One host read keeps the standing-grant surface to a single consent
      // moment in the scripted beat (the email is the delivery story, exactly
      // like the weekly digest above).
      run: {
        kind: "steps",
        steps: [{ id: "balance", tool: "host_listAccounts" }],
      },
    },
  };
}

function fixtureDocument(fixture: unknown, id: string): AppDocument {
  return { ...(fixture as Omit<AppDocument, "id">), id, format: "vendo/app@1" };
}

/** Insert-if-absent all scripted-demo rows for every seeded Maple user.
 *  Store-agnostic on purpose: writes ride the PUBLIC records door
 *  (`store.records("vendo_apps")` — the reserved-collection routing every
 *  VendoStore implements), so seeding behaves identically on the local PGlite
 *  store and the Cloud hosted store. */
export async function seedDemoScript(): Promise<void> {
  await vendo.store.ensureSchema();
  const apps = vendo.store.records("vendo_apps");
  for (const user of mapleDemoUsers()) {
    const rows: AppDocument[] = [
      fixtureDocument(spendingFixture, demoAppId("spending", user.subject)),
      fixtureDocument(moneyHqFixture, demoAppId("moneyhq", user.subject)),
      weeklySummaryDocument(demoAppId("weekly", user.subject)),
      lowBalanceAlertDocument(demoAppId("lowbalance", user.subject)),
    ];
    for (const doc of rows) {
      const existing = await apps.get(doc.id);
      if (existing !== null) continue; // never clobber recorded pins/edits
      await apps.put({ id: doc.id, data: { subject: user.subject, enabled: false, doc } });
    }
  }
  await seedConsoleData(vendo.store);
}
