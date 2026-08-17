/**
 * The `vendo.json` fold-in — a machine app's declared schedules becoming real
 * automations.
 *
 * A manifest is CODE, so the fold-in is a reconcile, and it is the SAME
 * reconcile `agent.on` runs at boot: core's `reconcileAutomations`, written
 * once. What this pins is the three answers that reconcile has to produce
 * through the seam — an unchanged manifest touching nothing, a changed cron
 * replacing its own record, and a dropped schedule disarming its own — plus the
 * app's list being maintained here and only here.
 */
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type RunContext,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createManifestTriggers } from "../src/server/escalation/manifest-triggers.js";
import type { MachineLifecycle } from "../src/server/escalation/machine-lifecycle.js";
import type { EngineOps } from "../src/server/persistence/engine.js";
import { fakeAutomations } from "./automations-double.test-util.js";

const APP_ID = "app_boxed";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

const app = (automations?: string[]): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: APP_ID,
  name: "Invoice box",
  ui: "http",
  machine: { snapshotRef: "e2b:snap_1", provisionedAt: "2026-08-17T00:00:00.000Z" },
  ...(automations === undefined ? {} : { automations }),
});

/** A box that serves exactly one `vendo.json`. */
const boxServing = (manifest: unknown): MachineLifecycle => ({
  async wake() {
    return {
      async request() {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode(JSON.stringify(manifest)),
        };
      },
    };
  },
} as unknown as MachineLifecycle);

/** One fold-in of `manifest` over `stored`, against a given engine — so a test
 *  can run two syncs in a row and watch the second one leave things alone. */
const foldIn = async (
  engine: ReturnType<typeof fakeAutomations>,
  manifest: unknown,
  stored: AppDocument,
) => await createManifestTriggers({
  engine: {} as unknown as EngineOps,
  lifecycle: boxServing(manifest),
  updateDocument: async (_appId, mutate) => mutate(stored) as AppDocument,
  automations: engine.seam,
}).sync(stored, ctx);

const ONE = { schedules: [{ cron: "0 8 * * *", fn: "chaseInvoices" }] };

describe("the vendo.json fold-in", () => {
  it("creates one armed automation per declared schedule and names it on the app", async () => {
    const engine = fakeAutomations();
    const synced = await foldIn(engine, ONE, app());

    expect(synced.automations).toHaveLength(1);
    expect(synced.automations[0]).toMatchObject({ cron: "0 8 * * *", fn: "chaseInvoices", arming: "armed" });
    const id = synced.automations[0]?.id as string;
    expect(synced.app.automations).toEqual([id]);
    expect(engine.records.get(id)).toMatchObject({
      when: { kind: "schedule", cron: "0 8 * * *" },
      task: { kind: "steps", steps: [{ id: "fire", tool: "fn:chaseInvoices" }] },
      authoredBy: "manifest",
    });
  });

  it("re-arms nothing when the manifest did not change — a kill switch survives a redeploy", async () => {
    const engine = fakeAutomations();
    const first = await foldIn(engine, ONE, app());
    const id = first.automations[0]?.id as string;
    // The person turned it off between the two syncs.
    await engine.seam.disable(id, ctx);

    const second = await foldIn(engine, ONE, first.app);

    // Nothing reported, because nothing was touched.
    expect(second.automations).toEqual([]);
    expect(engine.records.get(id)?.armed).toBe(false);
  });

  it("replaces a record whose cron changed, under the same identity", async () => {
    const engine = fakeAutomations();
    const first = await foldIn(engine, ONE, app());
    const id = first.automations[0]?.id as string;

    const moved = await foldIn(engine, { schedules: [{ cron: "0 9 * * *", fn: "chaseInvoices" }] }, first.app);

    expect(moved.automations[0]?.id).toBe(id);
    expect(engine.records.get(id)?.when).toEqual({ kind: "schedule", cron: "0 9 * * *" });
    expect(engine.records.size).toBe(1);
  });

  it("disarms a schedule the manifest dropped and stops naming it on the app", async () => {
    const engine = fakeAutomations();
    const first = await foldIn(engine, ONE, app());
    const id = first.automations[0]?.id as string;

    const dropped = await foldIn(engine, {}, first.app);

    expect(engine.disabled).toEqual([id]);
    expect(dropped.app.automations).toEqual([]);
    // Disarmed, never deleted: the run history has to survive.
    expect(engine.records.get(id)).toBeDefined();
  });

  it("refuses a cron no calendar time satisfies, at the read boundary", async () => {
    await expect(foldIn(fakeAutomations(), { schedules: [{ cron: "99 99 * * *", fn: "x" }] }, app()))
      .rejects.toThrow(/cron/i);
  });

  it("says so when two schedules collapse to one identity", async () => {
    await expect(foldIn(fakeAutomations(), {
      schedules: [{ cron: "0 8 * * *", fn: "digest" }, { cron: "0 9 * * *", fn: "digest" }],
    }, app())).rejects.toThrow(/give each schedule its own fn/);
  });

  it("refuses to pretend, when the deployment composed no automations engine", async () => {
    const triggers = createManifestTriggers({
      engine: {} as unknown as EngineOps,
      lifecycle: boxServing(ONE),
      updateDocument: async () => app(),
    });

    await expect(triggers.sync(app(), ctx)).rejects.toThrow(/no automations engine/);
  });
});
