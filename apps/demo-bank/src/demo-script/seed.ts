/**
 * Scripted-demo seeding — idempotent. Runs at server boot (instrumentation.ts)
 * and again after /api/demo/reset, so the demo always starts scripted-ready:
 *
 * - the two fixture microapps ("Spending This Month", "Money HQ") exist for
 *   every seeded Maple user under DETERMINISTIC app ids the scripted turn
 *   engine references;
 * - the automation documents in ./automations exist DISABLED — the "Email me a
 *   weekly summary" and "Alert me before I overdraft" beats enable the first
 *   two through the real automations engine, surfacing the standing-grant asks
 *   in-thread, and "Friday savings sweep" is the rehearsal showcase.
 *
 * Existing rows are left untouched (a user's recorded pins survive), so
 * seeding is safe to run on every boot.
 */
import type { AppDocument } from "@vendoai/core";
import { mapleDemoUsers } from "@/server/users";
import { vendo } from "@/vendo/server";
import { demoAppId, mapleDemoAutomations } from "./automations";
import moneyHqFixture from "./fixtures/money-hq.json";
import spendingFixture from "./fixtures/spending-breakdown.json";

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
      ...mapleDemoAutomations(user.subject),
    ];
    for (const doc of rows) {
      const existing = await apps.get(doc.id);
      if (existing !== null) continue; // never clobber recorded pins/edits
      await apps.put({ id: doc.id, data: { subject: user.subject, enabled: false, doc } });
    }
  }
}

// The scripted turn engine references app ids from here (./engine imports
// demoAppId from this module); re-exported so that import path stays put.
export { demoAppId } from "./automations";
