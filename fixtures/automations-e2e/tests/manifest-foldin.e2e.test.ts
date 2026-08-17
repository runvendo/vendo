/** There is exactly ONE scheduling system: automation RECORDS fired by the
 * automations engine. A machine app's `vendo.json` schedules are no longer a
 * second scheduler with its own tick and its own last-fired cache — they are
 * folded in as ordinary records authored `manifest`, through the SAME shared
 * `reconcileAutomations` helper `agent.on`'s boot reconcile uses and the same one
 * create operation every other authoring door calls. Which means a manifest fire
 * now gets what only declared automations used to get: a run record, an identity,
 * the kill switch, and a row in the panel.
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
import type { AppDocument, AppId, AutomationRecord, RunContext } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import { appsAutomationsSeam, createStack, ownerCtx, resetFixture, type Stack } from "../src/harness.js";
import { ADA, runCount } from "../src/support.js";

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
 * and create seam — the umbrella's wiring, not a stand-in for it.
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
  automations: appsAutomationsSeam(stack.automations, stack.create),
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

/** What the fold-in wrote, read back through the engine's own list. `manifest`
 *  is the author a manifest reconcile diffs — and the only one it may touch. */
const manifestRecords = async (stack: Stack, ctx: RunContext): Promise<AutomationRecord[]> =>
  (await stack.automations.list({ owner: ADA.subject }, ctx))
    .filter((record) => record.authoredBy === "manifest");

/** The record that fires one declared fn. A schedule's identity is its fn, so
 *  there is exactly one of these however many times the manifest is folded in. */
const forFn = (records: readonly AutomationRecord[], fn: string): AutomationRecord | undefined =>
  records.find(({ task }) => task.kind === "steps" && task.steps[0]?.tool === `fn:${fn}`);

describe("vendo.json schedules fold into automation records", () => {
  beforeEach(resetFixture);

  it("converts a manifest cron into an armed record the engine's own tick fires", async () => {
    let clock = new Date("2026-07-12T09:00:00.000Z");
    const { adapter, fires } = manifestBox([{ cron: "* * * * *", fn: "chase" }]);
    const stack = await createStack({ now: () => clock, sandbox: adapter });
    try {
      const appId = "app_manifest_cron";
      const ctx = ownerCtx(ADA.subject, appId);
      const apps = boxEditor(stack, adapter);
      await stack.putApp(ADA.subject, machineDoc(appId));

      // The cron lives only in the box, so no automation exists yet and the
      // panel has no row.
      expect(await stack.automations.list({}, ctx)).toEqual([]);

      await editServer(apps, appId, "chase overdue invoices every minute", ctx);

      // The manifest schedule is now an ordinary record of the app's owner,
      // ARMED, authored `manifest` — read where it is true: the automations
      // engine's own row, not the converter's report.
      const records = await manifestRecords(stack, ctx);
      expect(records).toHaveLength(1);
      const chase = records[0]!;
      expect(chase).toMatchObject({
        owner: { kind: "user", subject: ADA.subject },
        when: { kind: "schedule", cron: "* * * * *" },
        task: { kind: "steps", steps: [{ id: "fire", tool: "fn:chase" }] },
        armed: true,
      });

      // FIRES, through the automations tick — not a second scheduler. Nothing
      // registers an `fn:` descriptor for the step loop (the in-runtime fn path
      // is a later project), so the approved shape is: the record ARMS, then
      // fires into a loud, NAMED error row — strictly better than the old
      // silent never-armed. When the fn path lands, this is what notices.
      clock = new Date("2026-07-12T09:01:30.000Z");
      const ids = await stack.automations.tick(clock);
      expect(ids).toHaveLength(1);
      const run = await stack.automations.runs.get(ids[0]!, ctx);
      expect(run?.automationId).toBe(chase.id);
      expect(run?.status).toBe("error");
      expect(run?.trigger.kind).toBe("schedule");
      // The row names the tool it could not resolve, so the ledger reads.
      expect(run?.error).toMatchObject({ code: "not-found", message: "Tool fn:chase was not found" });
      expect(run?.steps.map(({ tool, outcome }) => ({ tool, outcome })))
        .toEqual([{ tool: "fn:chase", outcome: "error" }]);
      // The box's own fn door is never reached, because the step never resolved.
      expect(fires).toEqual([]);

      // EXACTLY ONCE: a double tick inside the same cron window is a no-op.
      // Witnessed on the run rows themselves — `fires` can no longer grow, so
      // it would prove nothing here.
      clock = new Date("2026-07-12T09:01:45.000Z");
      expect(await stack.automations.tick(clock)).toEqual([]);
      expect(await runCount(stack, chase.id)).toBe(1);

      // The kill switch reaches it, because it is a record like any other.
      await stack.automations.disable(chase.id, ctx);
      clock = new Date("2026-07-12T09:03:00.000Z");
      expect(await stack.automations.tick(clock)).toEqual([]);
      expect(await runCount(stack, chase.id)).toBe(1);

      // And the NEXT edit does not undo that decision: the reconcile leaves a
      // record a PERSON disarmed exactly as they left it, redeploy after
      // redeploy. That guarantee is the point of this suite.
      await editServer(apps, appId, "tidy the chase copy, leave the schedule alone", ctx);
      expect(await manifestRecords(stack, ctx))
        .toMatchObject([{ id: chase.id, armed: false, disarmedBy: "user" }]);
      clock = new Date("2026-07-12T09:04:00.000Z");
      expect(await stack.automations.tick(clock)).toEqual([]);
      expect(await runCount(stack, chase.id)).toBe(1);
    } finally {
      await stack.close();
    }
  });

  it("updates a changed cron, disarms a dropped schedule, and never touches a chat-authored record", async () => {
    let clock = new Date("2026-07-12T09:00:00.000Z");
    const box = manifestBox([{ cron: "0 * * * *", fn: "chase" }, { cron: "0 8 * * *", fn: "digest" }]);
    const stack = await createStack({ now: () => clock, sandbox: box.adapter });
    try {
      const appId = "app_manifest_churn";
      const ctx = ownerCtx(ADA.subject, appId);
      const apps = boxEditor(stack, box.adapter);
      await stack.putApp(ADA.subject, machineDoc(appId));
      // A record the owner authored in chat, sitting beside the manifest's own.
      // Nothing a fold-in does may change, disarm or delete it.
      const mine = await stack.create({
        owner: ADA,
        when: { event: "invoice.created" },
        task: { kind: "steps", steps: [{ id: "list", tool: "host_invoices_list" }] },
        authoredBy: "chat",
      }, ctx);

      // Both schedules land, armed. Addressed by fn rather than by position:
      // two records written in the same millisecond tie-break on a random uuid
      // in the keyset order (`packages/store/src/schema.ts:337`), so their
      // relative order is a coin flip and asserting it is asserting the coin.
      await editServer(apps, appId, "chase hourly and send a morning digest", ctx);
      const folded = await manifestRecords(stack, ctx);
      expect(folded).toHaveLength(2);
      expect(forFn(folded, "chase"))
        .toMatchObject({ when: { kind: "schedule", cron: "0 * * * *" }, armed: true });
      expect(forFn(folded, "digest"))
        .toMatchObject({ when: { kind: "schedule", cron: "0 8 * * *" }, armed: true });

      // The manifest changes inside the box: chase's cron moves, digest is gone.
      box.state.schedules = [{ cron: "30 * * * *", fn: "chase" }];
      await editServer(apps, appId, "move chase to half past and drop the digest", ctx);

      const after = await manifestRecords(stack, ctx);
      // Chase was updated in place — one record per declared fn, never a second
      // beside it — and the dropped digest is disarmed rather than deleted, so
      // its run history survives.
      expect(after).toHaveLength(2);
      expect(forFn(after, "chase"))
        .toMatchObject({ when: { kind: "schedule", cron: "30 * * * *" }, armed: true });
      expect(forFn(after, "digest")).toMatchObject({ armed: false });

      // The chat-authored record is untouched: a manifest reconcile only ever
      // diffs its own author.
      expect(await stack.automations.get(mine.id, ctx))
        .toMatchObject({ authoredBy: "chat", armed: true });

      clock = new Date("2026-07-12T10:31:00.000Z");
      expect(await stack.automations.tick(clock)).toHaveLength(1);
      // The UPDATED cron is what fired, witnessed on chase's own run rows — an
      // `fn:` step never reaches the box's fn door, as the first case pins.
      expect(await runCount(stack, forFn(after, "chase")!.id)).toBe(1);
      expect(box.fires).toEqual([]);
    } finally {
      await stack.close();
    }
  });
});
