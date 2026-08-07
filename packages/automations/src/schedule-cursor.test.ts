/** The schedule cursor across the (app, trigger) rekey.
 *
 * An automation is an app with a LIST of triggers, so everything keyed to one
 * moved from the bare `appId` to `<appId>:<triggerId>` — the schedule cursor
 * included. `automations:schedule` is a GENERIC collection keyed by row id, and no
 * store rewrites generic row ids: the reserved store's own migrations work by
 * generated columns over reserved tables, which this is not. So the pre-rekey
 * cursor is invisible on EVERY store, not just a host-supplied one.
 *
 * A missing cursor is not read as "overdue" — deliberately, since a schedule
 * discovered for the first time must not fire for every window since the epoch.
 * It is read as "start the clock now". Applied to a cursor that merely moved, that
 * silently restarts a running automation's clock: the firing it was due for is
 * skipped and it fires up to one interval late, once, with nothing anywhere saying
 * so.
 */
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type ApprovalId,
  type AuditEvent,
  type Guard,
  type StoreAdapter,
  type ToolRegistry,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import type { AppsRuntime } from "@vendoai/apps";
import { beforeEach, describe, expect, it } from "vitest";
import { createAutomations } from "./index.js";

const NOW = new Date("2026-08-05T12:00:00.000Z");
const HOUR = 3_600_000;
const OWNER = "user_cursor";
const SCHEDULE = "automations:schedule";

class GuardDouble implements Guard {
  async check(): Promise<{ action: "run"; decidedBy: "default" }> {
    return { action: "run", decidedBy: "default" };
  }
  async report(_event: AuditEvent): Promise<void> {}
  async directions(): Promise<string[]> { return []; }
  onApprovalDecision(_callback: (id: ApprovalId, approved: boolean) => void): () => void {
    return () => {};
  }
}

const tools: ToolRegistry = {
  async descriptors() {
    return [{ name: "host_sync", description: "Sync", inputSchema: { type: "object" }, risk: "read" }];
  },
  async execute() { return { status: "ok", output: {} }; },
};

const appsDouble = (): AppsRuntime => ({ call: async () => ({ status: "ok", output: {} }) }) as AppsRuntime;

const hourly = (id: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: id,
  triggers: [{
    id: "main",
    on: { kind: "schedule", every: "1h" },
    run: { kind: "steps", steps: [{ id: "sync", tool: "host_sync" }] },
  }],
});

describe("pre-rekey schedule cursors", () => {
  let store: StoreAdapter;

  beforeEach(() => {
    store = memoryStoreAdapter();
  });

  const engine = () => createAutomations({
    apps: appsDouble(), tools, guard: new GuardDouble(), store, now: () => NOW,
  });

  /** An armed hourly automation whose cursor sits where the code used to put it.
   *  Three hours ago by default, so it is two windows overdue right now. */
  async function seedPreRekey(id: string, lastFiredHoursAgo = 3): Promise<AppDocument> {
    const doc = hourly(id);
    await store.records("vendo_apps").put({
      id: doc.id,
      data: { subject: OWNER, enabled: true, doc },
      refs: { subject: OWNER },
    });
    await store.records(SCHEDULE).put({
      id: doc.id,
      data: { lastFiredAt: new Date(NOW.getTime() - lastFiredHoursAgo * HOUR).toISOString() },
    });
    return doc;
  }

  it("fires an overdue automation whose cursor predates the (app, trigger) rekey", async () => {
    await seedPreRekey("app_cursor_due");

    const fired = await engine().tick(NOW);

    expect(fired).toHaveLength(1);
  });

  it("carries the old cursor's state onto the new key and leaves no duplicate behind", async () => {
    const doc = await seedPreRekey("app_cursor_moved");

    await engine().tick(NOW);

    // The pair key now holds the cursor, advanced by this firing…
    const moved = await store.records(SCHEDULE).get(`${doc.id}:main`);
    expect(moved?.data).toMatchObject({ lastFiredAt: NOW.toISOString() });
    // …and the row it came from is gone, so it can never be read again and
    // re-migrated over a cursor that has since moved on.
    expect(await store.records(SCHEDULE).get(doc.id)).toBeNull();
  });

  it("gives the carried cursor the app ref its pre-rekey row never had", async () => {
    // Not due, so the tick writes nothing after the move: the ref has to come
    // from the move itself, or the app-erase cascade can never collect this row.
    const doc = await seedPreRekey("app_cursor_refs", 0.5);

    expect(await engine().tick(NOW)).toEqual([]);

    expect((await store.records(SCHEDULE).get(`${doc.id}:main`))?.refs).toEqual({ app_id: doc.id });
  });

  it("does not resurrect a pre-rekey cursor once the pair key already has one", async () => {
    const doc = await seedPreRekey("app_cursor_own");
    // The automation has already fired since the rekey: the pair key is current
    // and the stale bare-id row must not be allowed to drag it backwards.
    await store.records(SCHEDULE).put({
      id: `${doc.id}:main`,
      data: { lastFiredAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() },
    });

    // Five minutes into an hourly window, so nothing is due — unless the
    // three-hours-ago row won.
    expect(await engine().tick(NOW)).toEqual([]);
  });
});
