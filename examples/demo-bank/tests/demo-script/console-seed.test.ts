/**
 * The console seed's producer/consumer seam.
 *
 * `seedConsoleData` writes `vendo_automations` and `vendo_runs` rows that nothing in
 * this app reads back — the Vendo automations engine does, through the same
 * `/runs` door the Automations tab calls. So both halves are REAL here: the
 * shipped seeder writes into a real store, and the shipped composition reads
 * out of it, with no stub on either side. A seed shaped for an older row
 * schema is invisible to a test that reads its own writes, and shipped as four
 * 400s on the live demo's Automations tab.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunContext } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { createVendo, type Vendo } from "@vendoai/vendo/server";
import { mapleDemoUsers } from "@/server/users";
import { seedConsoleData, seedId } from "../../src/demo-script/console-seed";

const ctx = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

describe("console seed", () => {
  let dataDir: string;
  let store: VendoStore;
  let vendo: Vendo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "maple-console-seed-"));
    store = createStore({ dataDir });
    await store.ensureSchema();
    await seedConsoleData(store);
    // Construction needs an identity even though this suite drives the
    // automations API directly with its own RunContext — the wire resolver is
    // never reached here.
    vendo = createVendo({
      store,
      principal: async () => ({ kind: "user", subject: mapleDemoUsers()[0]!.subject }),
    });
  }, 120_000);

  afterAll(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("gives every seeded automation a run history the Automations tab can read", async () => {
    const subject = mapleDemoUsers()[0]!.subject;
    const listed = await vendo.automations.list({ owner: subject }, ctx(subject));
    expect(listed.length).toBeGreaterThan(0);

    // The panel's health strip fetches runs per automation, exactly like this.
    // A record whose rows the engine cannot parse throws instead of answering,
    // and the tab's strip goes missing behind a 400.
    const withHistory: string[] = [];
    for (const record of listed) {
      const { runs } = await vendo.automations.runs.list({ automationId: record.id }, ctx(subject));
      if (runs.length > 0) withHistory.push(record.id);
    }
    // The four with a cadence that has already fired: the low-balance alert,
    // the bill review, the payday sweep and the weekly digest.
    expect(withHistory.sort()).toEqual(
      ["billreview", "lowbalance500", "paydaysweep", "weeklydigest"]
        .map((key) => seedId(key, subject)),
    );
  }, 120_000);
});
