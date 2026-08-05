/** There is exactly ONE scheduling system: doc triggers fired by the automations
 * engine. A machine app's `vendo.json` schedules are no longer a second
 * scheduler with its own tick and its own last-fired cache — they are CONVERTED
 * into ordinary doc triggers at manifest-sync time, armed through the arming
 * seam, and fired by the same tick every other automation rides. Which means a
 * manifest fire now gets what only doc triggers used to get: a run record, a
 * trigger id, the kill switch, and a row in the panel.
 *
 * The box here is an in-test v2 sandbox adapter serving the real box door
 * (`GET /vendo.json`, `POST /fn/<name>`), which is the pattern every non-live
 * box test in this repo uses (`packages/apps/src/schedules.test.ts`,
 * `packages/vendo/src/schedule-wire.test.ts`); real e2b appears only in the
 * opt-in `*.live.test.ts` suites.
 */
import type { SandboxAdapter, SandboxMachine } from "@vendoai/apps";
import type { AppDocument } from "@vendoai/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createStack, ownerCtx, resetFixture, type Stack } from "./harness.js";
import { ADA } from "./support.js";

const encoder = new TextEncoder();

/** A box declaring `schedules` in its manifest, counting each fn fire. The
 *  manifest is mutable so a suite can edit it the way an in-box agent would. */
function manifestBox(initial: Array<{ cron: string; fn: string }>) {
  const fires: string[] = [];
  const state = { schedules: initial };
  const machine: SandboxMachine = {
    id: "fake_manifest_box",
    async request(request) {
      const respond = (status: number, payload: unknown) => ({
        status,
        headers: { "content-type": "application/json" },
        body: encoder.encode(JSON.stringify(payload)),
      });
      if (request.method === "GET" && request.path === "/vendo.json") {
        return respond(200, { schedules: state.schedules });
      }
      if (request.method === "POST" && request.path.startsWith("/fn/")) {
        fires.push(request.path.slice("/fn/".length));
        return respond(200, { result: { chased: true } });
      }
      return { status: 404, headers: {}, body: new Uint8Array() };
    },
    // The fold-in journey is the manifest and the fn door, never the box's
    // disk — the seam member is here so this double stays a whole
    // SandboxMachine, and it fails loudly rather than answering a file it does
    // not hold.
    files: {
      async read(path) { throw new Error(`the manifest box holds no files (${path})`); },
      async write(path) { throw new Error(`the manifest box holds no files (${path})`); },
      async list(dir) { throw new Error(`the manifest box holds no files (${dir})`); },
    },
    async url(port?: number) { return `https://${port ?? 8080}-fake_manifest_box.foldin.test`; },
    async snapshot() { return "fake:manifest-snap"; },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
  };
  const adapter: SandboxAdapter = {
    async create() { return machine; },
    async resume() { return machine; },
    async destroy() { /* released */ },
  };
  return { adapter, fires, state };
}

const machineDoc = (id: string): AppDocument => ({
  format: "vendo/app@1",
  id,
  name: "Chaser box",
  machine: { snapshotRef: "fake:manifest-snap", provisionedAt: "2026-07-12T00:00:00.000Z" },
});

const triggerRows = async (stack: Stack, appId: string) =>
  (await stack.automations.list(ownerCtx(ADA.subject)))
    .find((entry) => entry.app.id === appId)
    ?.triggers.map(({ trigger, enabled }) => ({ id: trigger.id, on: trigger.on, run: trigger.run, enabled }));

const runCount = async (stack: Stack, appId: string): Promise<number> => Number((await stack.sql<{ count: unknown }>(
  "SELECT COUNT(*)::int AS count FROM vendo_runs WHERE app_id = $1",
  [appId],
))[0]?.count);

describe("vendo.json schedules fold into doc triggers", () => {
  beforeEach(resetFixture);

  it("converts a manifest cron into an armed doc trigger the engine's own tick fires", async () => {
    let clock = new Date("2026-07-12T09:00:00.000Z");
    const { adapter, fires } = manifestBox([{ cron: "* * * * *", fn: "chase" }]);
    const stack = await createStack({ now: () => clock, sandbox: adapter });
    try {
      const appId = "app_manifest_cron";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, machineDoc(appId));

      // Nothing is declared on the document yet — the cron lives only in the
      // box, so the app is not an automation at all and the panel has no row.
      expect(await triggerRows(stack, appId)).toBeUndefined();

      const synced = await stack.apps.machine.syncManifest(appId, ctx);
      expect(synced.triggers.map(({ id, arming }) => ({ id, arming })))
        .toEqual([{ id: "manifest_chase", arming: "armed" }]);

      // The manifest schedule is now an ordinary trigger of the app, armed.
      expect(await triggerRows(stack, appId)).toEqual([{
        id: "manifest_chase",
        on: { kind: "schedule", cron: "* * * * *" },
        run: { kind: "steps", steps: [{ id: "fire", tool: "fn:chase" }] },
        enabled: true,
      }]);
      // Arming captured an empty consent surface (fn: steps run in the app's own
      // box), so nothing was left waiting on a permission decision.
      expect(await triggerRows(stack, appId)).not.toContainEqual(
        expect.objectContaining({ pendingGrants: expect.anything() }),
      );

      // FIRES, through the automations tick — not a second scheduler.
      clock = new Date("2026-07-12T09:01:30.000Z");
      const ids = await stack.automations.tick(clock);
      expect(ids).toHaveLength(1);
      const run = await stack.automations.runs.get(ids[0]!, ctx);
      expect(run?.triggerId).toBe("manifest_chase");
      expect(run?.status).toBe("ok");
      expect(run?.trigger.kind).toBe("schedule");
      expect(run?.steps.map(({ tool, outcome }) => ({ tool, outcome })))
        .toEqual([{ tool: "fn:chase", outcome: "ok" }]);
      // The box really ran the declared fn.
      expect(fires).toEqual(["chase"]);

      // EXACTLY ONCE: a double tick inside the same cron window is a no-op.
      clock = new Date("2026-07-12T09:01:45.000Z");
      expect(await stack.automations.tick(clock)).toEqual([]);
      expect(fires).toEqual(["chase"]);
      expect(await runCount(stack, appId)).toBe(1);

      // The kill switch reaches it, because it is a run like any other.
      await stack.automations.disable(appId, "manifest_chase", ctx);
      clock = new Date("2026-07-12T09:03:00.000Z");
      expect(await stack.automations.tick(clock)).toEqual([]);
      expect(fires).toEqual(["chase"]);

      // And a re-sync of the UNCHANGED manifest does not undo that decision: it
      // reports the trigger as untouched rather than re-arming it (and rather
      // than claiming an arm state it cannot see — the armed row is the
      // automations engine's, not this converter's).
      const resynced = await stack.apps.machine.syncManifest(appId, ctx);
      expect(resynced.triggers.map(({ id, arming }) => ({ id, arming })))
        .toEqual([{ id: "manifest_chase", arming: "unchanged" }]);
      clock = new Date("2026-07-12T09:04:00.000Z");
      expect(await stack.automations.tick(clock)).toEqual([]);
      expect(fires).toEqual(["chase"]);
    } finally {
      await stack.close();
    }
  });

  it("updates a changed cron, removes a dropped schedule, and never touches a user-authored trigger", async () => {
    let clock = new Date("2026-07-12T09:00:00.000Z");
    const box = manifestBox([{ cron: "0 * * * *", fn: "chase" }, { cron: "0 8 * * *", fn: "digest" }]);
    const stack = await createStack({ now: () => clock, sandbox: box.adapter });
    try {
      const appId = "app_manifest_churn";
      const ctx = ownerCtx(ADA.subject, appId);
      await stack.putApp(ADA.subject, {
        ...machineDoc(appId),
        // A hand-authored trigger sitting beside the converted ones. Nothing the
        // converter does may change, disarm or delete it.
        triggers: [{
          id: "mine",
          on: { kind: "host-event", event: "invoice.created" },
          run: { kind: "steps", steps: [{ id: "list", tool: "host_invoices_list" }] },
        }],
      });

      await stack.apps.machine.syncManifest(appId, ctx);
      expect((await triggerRows(stack, appId))?.map(({ id }) => id))
        .toEqual(["mine", "manifest_chase", "manifest_digest"]);

      // The manifest changes inside the box: chase's cron moves, digest is gone.
      box.state.schedules = [{ cron: "30 * * * *", fn: "chase" }];
      await stack.apps.machine.syncManifest(appId, ctx);

      const after = await triggerRows(stack, appId);
      expect(after?.map(({ id, on }) => ({ id, on }))).toEqual([
        { id: "mine", on: { kind: "host-event", event: "invoice.created" } },
        { id: "manifest_chase", on: { kind: "schedule", cron: "30 * * * *" } },
      ]);
      // The user-authored trigger kept its own arm state (never armed here).
      expect(after?.find(({ id }) => id === "mine")?.enabled).toBe(false);
      expect(after?.find(({ id }) => id === "manifest_chase")?.enabled).toBe(true);

      clock = new Date("2026-07-12T10:31:00.000Z");
      const ids = await stack.automations.tick(clock);
      expect(ids).toHaveLength(1);
      expect(box.fires).toEqual(["chase"]);
    } finally {
      await stack.close();
    }
  });

  it("carries the old scheduler's last-fired state across the cutover: no window fires twice, none is skipped", async () => {
    // The legacy `vendo_app_schedules` row is what a deployment running the OLD
    // machine-app scheduler has in its database right now. Its `lastFiredAt` is
    // the OCCURRENCE the old engine already fired; `since` is far older. Seeding
    // the new per-trigger cursor from `since` (or from nothing) would re-fire a
    // window that already ran; seeding it from `now` would silently skip a
    // window the old engine had not reached yet. Both are proven here.
    let clock = new Date("2026-07-12T10:30:00.000Z");
    const { adapter, fires } = manifestBox([{ cron: "0 * * * *", fn: "chase" }]);
    const stack = await createStack({ now: () => clock, sandbox: adapter });
    try {
      const alreadyFired = "app_legacy_fired";
      const missedWindow = "app_legacy_missed";
      await stack.putApp(ADA.subject, machineDoc(alreadyFired));
      await stack.putApp(ADA.subject, machineDoc(missedWindow));

      // (a) The old engine already fired the 10:00 window.
      await stack.store.records("vendo_app_schedules").put({
        id: alreadyFired,
        data: {
          syncedAt: "2026-07-01T00:00:00.000Z",
          schedules: [{
            cron: "0 * * * *",
            fn: "chase",
            since: "2026-07-01T00:00:00.000Z",
            lastFiredAt: "2026-07-12T10:00:00.000Z",
            lastStatus: "ok",
          }],
        },
      });
      // (b) The old engine last fired the 09:00 window; 10:00 was missed.
      await stack.store.records("vendo_app_schedules").put({
        id: missedWindow,
        data: {
          syncedAt: "2026-07-01T00:00:00.000Z",
          schedules: [{
            cron: "0 * * * *",
            fn: "chase",
            since: "2026-07-01T00:00:00.000Z",
            lastFiredAt: "2026-07-12T09:00:00.000Z",
          }],
        },
      });

      await stack.apps.machine.syncManifest(alreadyFired, ownerCtx(ADA.subject, alreadyFired));
      await stack.apps.machine.syncManifest(missedWindow, ownerCtx(ADA.subject, missedWindow));

      const ids = await stack.automations.tick(clock);
      const runs = await Promise.all(ids.map(async (id) =>
        await stack.automations.runs.get(id, ownerCtx(ADA.subject, missedWindow))));
      // (a) fires nothing — its window is spent. (b) fires exactly once.
      expect(runs.map((run) => run?.appId)).toEqual([missedWindow]);
      expect(fires).toEqual(["chase"]);
      expect(await runCount(stack, alreadyFired)).toBe(0);
      expect(await runCount(stack, missedWindow)).toBe(1);

      // And the recovered window is not replayed on the next tick either.
      clock = new Date("2026-07-12T10:45:00.000Z");
      expect(await stack.automations.tick(clock)).toEqual([]);
      expect(fires).toEqual(["chase"]);
    } finally {
      await stack.close();
    }
  });
});
