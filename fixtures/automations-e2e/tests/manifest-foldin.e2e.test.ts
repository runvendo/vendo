/** There is exactly ONE scheduling system: doc triggers fired by the automations
 * engine. A machine app's `vendo.json` schedules are no longer a second
 * scheduler with its own tick and its own last-fired cache — they are CONVERTED
 * into ordinary doc triggers, armed through the arming seam, and fired by the
 * same tick every other automation rides. Which means a manifest fire now gets
 * what only doc triggers used to get: a run record, a trigger id, the kill
 * switch, and a row in the panel.
 *
 * WHEN that conversion happens is nobody's decision: a box edit folds the
 * manifest in on its way out — `editServerViaBox`
 * (`packages/apps/src/box-lane.ts`) calls the converter the moment the in-box
 * agent reports success, while the box is still awake and before its egress
 * declaration lands on the doc. There is no other door onto the converter, so
 * every case below provokes it the way production does: by editing the app's
 * server through `apps.edit`, which on a served app hands the whole instruction
 * to the in-box agent.
 *
 * The box here is an in-test v2 sandbox adapter serving the REAL box doors on
 * both of a box's listeners — the harness control port (the in-box agent's task
 * protocol an edit rides) and the app's own port (`GET /vendo.json`,
 * `POST /fn/<name>`). That is the pattern every non-live box test in this repo
 * uses; real e2b appears only in the opt-in `*.live.test.ts` suites.
 */
import {
  createApps,
  type AppsRuntime,
  type SandboxAdapter,
  type SandboxMachine,
} from "@vendoai/apps";
import type { AppDocument, AppId, RunContext } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import { createStack, ownerCtx, resetFixture, type Stack } from "../src/harness.js";
import { ADA } from "../src/support.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The harness's control port, as `packages/apps/src/box-agent.ts` fixes it.
 *  Spelled out rather than imported for the reason a real provider would: a
 *  sandbox adapter is on the other side of the seam and does not import our
 *  constants. */
const BOX_CONTROL_PORT = 8811;

/** A box declaring `schedules` in its manifest, counting each fn fire. The
 *  manifest is mutable so a suite can edit it the way an in-box agent would. */
function manifestBox(initial: Array<{ cron: string; fn: string }>) {
  const fires: string[] = [];
  /** Every instruction the in-box agent was handed, in order. */
  const edits: string[] = [];
  const state = { schedules: initial };
  const tasks = new Map<string, { status: "done"; result: unknown }>();
  const respond = (status: number, payload: unknown) => ({
    status,
    headers: { "content-type": "application/json" },
    body: encoder.encode(JSON.stringify(payload)),
  });
  const machine: SandboxMachine = {
    id: "fake_manifest_box",
    async request(request) {
      const body = request.body === undefined
        ? ""
        : typeof request.body === "string" ? request.body : decoder.decode(request.body);
      // ── the harness control port: the in-box agent an edit talks to ────────
      if (request.port === BOX_CONTROL_PORT) {
        if (request.method === "POST" && request.path === "/agent/env") return respond(200, { ok: true });
        if (request.method === "POST" && request.path === "/agent/task") {
          edits.push((JSON.parse(body) as { prompt: string }).prompt);
          const taskId = `boxtask_${tasks.size}`;
          // The agent's whole output here IS the manifest: `state.schedules` is
          // what it just wrote to vendo.json, and the host reads it back over
          // the app port below.
          tasks.set(taskId, {
            status: "done",
            result: { ok: true, summary: "wrote vendo.json", filesChanged: ["/app/vendo.json"], testsRun: 0 },
          });
          return respond(202, { taskId });
        }
        if (request.method === "GET" && request.path.startsWith("/agent/task/")) {
          const entry = tasks.get(request.path.slice("/agent/task/".length));
          return entry === undefined ? respond(404, { error: "unknown task" }) : respond(200, entry);
        }
        return respond(404, { error: `unknown control route: ${request.method} ${request.path}` });
      }
      // ── the app's own port ────────────────────────────────────────────────
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
  return { adapter, fires, edits, state };
}

/** A GRADUATED, box-served app: `ui: "http"` is what sends an edit straight to
 *  the in-box agent (`write-surface.ts`), which is the path that folds the
 *  manifest in. The snapshot ref is the one this suite's box really hands back
 *  from `snapshot()`, so every wake resumes something the provider produced. */
const machineDoc = (id: string): AppDocument => ({
  format: "vendo/app@1",
  id,
  name: "Chaser box",
  ui: "http",
  machine: { snapshotRef: "fake:manifest-snap", provisionedAt: "2026-07-12T00:00:00.000Z" },
});

/**
 * The runtime that owns the box EDIT, over the stack's own store, guard, tools
 * and arming seam — the umbrella's wiring, not a stand-in for it.
 *
 * It exists beside `stack.apps` for one reason: the harness composes its runtime
 * without a model (its suites never generate), and the edit door refuses without
 * one — a permission-and-capability check that runs before the served branch,
 * which never calls a model at all. A served app has no tree for a brain to
 * rewrite; the whole instruction goes to the in-box agent.
 */
const boxEditor = (stack: Stack, sandbox: SandboxAdapter): AppsRuntime => createApps({
  store: stack.store,
  guard: stack.guard,
  tools: stack.bound,
  catalog: [],
  model: {} as LanguageModel,
  machine: {
    sandbox,
    // Idle auto-sleep is irrelevant here; a no-op clock keeps boxes awake.
    clock: { setTimeout: () => 0, clearTimeout: () => undefined },
    // This in-box agent answers immediately — no live box's long-poll to wait out.
    boxEditPollMs: 1,
  },
  armAutomation: (appId, triggerId, ctx) => stack.automations.enable(appId, triggerId, ctx),
});

/** ONE box edit through the production write path — and with it, one manifest
 *  fold-in. The edit has to SUCCEED for the fold-in to have happened: the sync
 *  runs only after the in-box agent reports ok. */
const editServer = async (
  apps: AppsRuntime,
  appId: AppId,
  instruction: string,
  ctx: RunContext,
): Promise<void> => {
  const result = await apps.edit(appId, instruction, ctx);
  expect(result.failure).toBeUndefined();
  expect(result.box?.ok).toBe(true);
};

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
      const apps = boxEditor(stack, adapter);
      await stack.putApp(ADA.subject, machineDoc(appId));

      // Nothing is declared on the document yet — the cron lives only in the
      // box, so the app is not an automation at all and the panel has no row.
      expect(await triggerRows(stack, appId)).toBeUndefined();

      await editServer(apps, appId, "chase overdue invoices every minute", ctx);

      // The manifest schedule is now an ordinary trigger of the app, ARMED —
      // which is the whole of what the converter reported as `arming: "armed"`,
      // read where it is true: the automations engine's own row.
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

      // And the NEXT edit does not undo that decision: its fold-in re-reads a
      // manifest that did not change, so the converter leaves the trigger's arm
      // state exactly as the person last set it (rather than re-arming it, or
      // claiming an arm state it cannot see — the armed row is the automations
      // engine's, not this converter's).
      await editServer(apps, appId, "tidy the chase copy, leave the schedule alone", ctx);
      expect((await triggerRows(stack, appId))?.map(({ id, on, enabled }) => ({ id, on, enabled })))
        .toEqual([{ id: "manifest_chase", on: { kind: "schedule", cron: "* * * * *" }, enabled: false }]);
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
      const apps = boxEditor(stack, box.adapter);
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

      await editServer(apps, appId, "chase hourly and send a morning digest", ctx);
      expect((await triggerRows(stack, appId))?.map(({ id }) => id))
        .toEqual(["mine", "manifest_chase", "manifest_digest"]);

      // The manifest changes inside the box: chase's cron moves, digest is gone.
      box.state.schedules = [{ cron: "30 * * * *", fn: "chase" }];
      await editServer(apps, appId, "move chase to half past and drop the digest", ctx);

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
    // window the old engine had not reached yet. Both are proven here — and the
    // carry happens where every fold-in happens, on the app's next box edit.
    let clock = new Date("2026-07-12T10:30:00.000Z");
    const { adapter, fires } = manifestBox([{ cron: "0 * * * *", fn: "chase" }]);
    const stack = await createStack({ now: () => clock, sandbox: adapter });
    try {
      const alreadyFired = "app_legacy_fired";
      const missedWindow = "app_legacy_missed";
      const apps = boxEditor(stack, adapter);
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

      await editServer(apps, alreadyFired, "keep chasing hourly", ownerCtx(ADA.subject, alreadyFired));
      await editServer(apps, missedWindow, "keep chasing hourly", ownerCtx(ADA.subject, missedWindow));

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
