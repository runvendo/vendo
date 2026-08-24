/**
 * The layering flip, and the ONE create operation under it.
 *
 * Two invariants live here, and both are about what an automation is NOT.
 *
 * 1. There is exactly one underlying create-automation operation. Every
 *    authoring door this package owns reaches `AutomationsSeam.create` and
 *    nothing else — `vendo_automate`, the chat lane behind
 *    `runtime.automation.author` (which is where `vendo_make`'s compound half
 *    enters, at `make-tool.ts`'s single `runtime.automation` call), and the
 *    reschedule door. A door that grew a create
 *    path of its own would still report a record, so the census below is over
 *    `creates`: a record can only exist by passing through the one operation,
 *    which makes that list the whole proof.
 *
 * 2. An automation carries no app reference of any kind. The pointer runs the
 *    other way — an app names a LIST of ids — and it is a list of names, not a
 *    foreign key: dead ids drop out on read, and deleting the APP leaves the
 *    automation firing and failing LOUDLY at tool resolution. That last one is
 *    the designed behavior, not a thing to guard against, so it is asserted
 *    here rather than defended against in the code.
 *
 * The engine behind the seam is a double because it has to be: `@vendoai/apps`
 * may import `@vendoai/core` and nothing else, so the seam IS the block
 * boundary. Everything on THIS side of it is real — the real tool registry, the
 * real store, the real access check, the real lane — and the double fakes
 * storage only, never policy: `toTriggerSource` is core's own and
 * `reconcileAutomations` is never stubbed at all. The two sides meeting for real
 * is the e2e fixtures' job.
 */
import {
  engineOverAdapter,
  VENDO_APP_FORMAT,
  VENDO_AUTOMATE_TOOL,
  type AppDocument,
  type RunContext,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "../src/server/index.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { scriptedLanguageModel } from "../src/server/testing/scripted-model.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";
import { fakeAutomations } from "./automations-double.test-util.js";

const APP_ID = "app_invoice_board";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

const tools: ToolRegistry = {
  async descriptors() {
    return [{
      name: "host_invoices_list",
      description: "Every invoice with its amount and due date.",
      inputSchema: { type: "object" },
      risk: "read",
    }];
  },
  async execute() {
    return { status: "ok", output: { items: [] } };
  },
};

/** A plain screen app with one declared data collection, so the app-data tools
 *  below have somewhere real to write. */
const seedDoc = (automations?: string[]): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: APP_ID,
  name: "Invoice board",
  ui: "tree",
  storage: { results: { about: "Latest automation result.", kind: "records" } },
  ...(automations === undefined ? {} : { automations }),
});

/** The planner's answer for whatever it is asked — agentic, so no results
 *  collection is declared and no board rewire is dragged into these tests. */
const PLAN = JSON.stringify({
  name: "Invoice nudge triage",
  when: { every: "1d" },
  task: { kind: "goal", prompt: "Decide who deserves a gentle vs firm nudge.", budget: { maxToolCalls: 20 } },
});

const hostWith = async (engine: ReturnType<typeof fakeAutomations>, automations?: string[]) => {
  const store = memoryStore();
  const runtime = createApps({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    automations: engine.seam,
    model: scriptedLanguageModel(() => PLAN),
  });
  await seedAppRow(engineOverAdapter(store), seedDoc(automations), ctx.principal.subject);
  return runtime;
};

const errorOf = (outcome: ToolOutcome): { code: string; message: string } => {
  if (outcome.status !== "error") throw new Error(`expected an error outcome, got ${JSON.stringify(outcome)}`);
  return outcome.error;
};

describe("the one create operation", () => {
  it("is what EVERY authoring door in this package reaches — no door mints a record of its own", async () => {
    const engine = fakeAutomations();
    const runtime = await hostWith(engine);

    // Door 1 — `vendo_automate`, through the real registry a host mounts.
    const automate = await runtime.agentTools().execute(
      { id: "call_1", tool: VENDO_AUTOMATE_TOOL, args: { when: "0 9 * * 1", task: "summarize the week" } as never },
      ctx,
    );
    expect(automate.status).toBe("ok");

    // Door 2 — the chat lane, which is where `vendo_make`'s compound half enters.
    const authored = await runtime.automation.author(
      { appId: APP_ID, instruction: "nudge everyone with an overdue invoice every day", mode: "goal" },
      ctx,
    );
    if (!authored.ok) throw new Error(`authoring failed: ${JSON.stringify(authored)}`);

    // Door 3 — the reschedule door, changing when that same record runs.
    await runtime.schedule(APP_ID, "0 6 * * *", ctx);

    // Three authoring acts, three trips through the one operation — and the
    // authors they declare are the ones the model allows.
    expect(engine.creates.map(({ authoredBy }) => authoredBy)).toEqual(["chat", "chat", "chat"]);
    // Every record any door reported is a record that came through it.
    expect(engine.records.has(authored.record.id)).toBe(true);
    // The reschedule was a REPLACE of the lane's record, not a second one: three
    // creates, but only two records, because it carried the id it was changing.
    expect(engine.creates[2]?.id).toBe(authored.record.id);
    expect(engine.records.size).toBe(2);
  });
});

describe("an automation has no app reference", () => {
  it("makes an app-linked and an app-less automation the SAME shape of record", async () => {
    const engine = fakeAutomations();
    const runtime = await hostWith(engine);
    const registry = runtime.agentTools();

    // App-linked only in the sense the model allows: the task NAMES the app's
    // own tool. That is an ordinary granted tool, so it leaves no trace on the
    // record — which is the whole point of the flip.
    await registry.execute({
      id: "call_linked",
      tool: VENDO_AUTOMATE_TOOL,
      args: { when: "0 9 * * 1", task: `write this week's figures into ${APP_ID} with vendo_apps_data_put` } as never,
    }, ctx);
    await registry.execute({
      id: "call_free",
      tool: VENDO_AUTOMATE_TOOL,
      args: { when: "0 9 * * 1", task: "email ops the weekly figures" } as never,
    }, ctx);

    const [linked, free] = [...engine.records.values()];
    expect(Object.keys(linked ?? {}).sort()).toEqual(Object.keys(free ?? {}).sort());
    // Not a field named for an app anywhere on either of them.
    for (const record of [linked, free]) {
      expect(Object.keys(record ?? {}).filter((key) => /app/i.test(key))).toEqual([]);
    }
  });
});

describe("an app's automations list is a list of names, not a foreign key", () => {
  it("drops a dead id on read and acts on the live one beside it", async () => {
    const engine = fakeAutomations();
    // The app names a record that no longer exists, and a real one after it.
    const live = await engine.seam.create({
      owner: ctx.principal,
      when: "0 9 * * 1",
      task: { kind: "goal", prompt: "nudge overdue invoices" },
      authoredBy: "chat",
    }, ctx);
    const runtime = await hostWith(engine, ["atm_deleted_long_ago", live.id]);

    const rescheduled = await runtime.schedule(APP_ID, "0 6 * * *", ctx);

    // The dead id neither threw nor was acted on; the live record was changed.
    expect(rescheduled).toMatchObject({ appId: APP_ID, cron: "0 6 * * *" });
    expect(engine.records.get(live.id)?.when).toEqual({ kind: "schedule", cron: "0 6 * * *" });
    expect(engine.records.has("atm_deleted_long_ago")).toBe(false);
  });

  it("reads an app whose only automation was deleted exactly like one that never had one", async () => {
    const engine = fakeAutomations();
    const runtime = await hostWith(engine, ["atm_deleted_long_ago"]);

    await expect(runtime.schedule(APP_ID, "0 6 * * *", ctx)).rejects.toThrow(/no schedule to change/);
  });
});

describe("a deleted app makes its automation fail loudly", () => {
  it("refuses the tool the task named, with the reason, instead of a silent no-op", async () => {
    const engine = fakeAutomations();
    const runtime = await hostWith(engine);
    const registry = runtime.agentTools();
    const publish = {
      id: "call_publish",
      tool: "vendo_apps_data_put",
      args: { appId: APP_ID, collection: "results", id: "latest", data: { nudged: 3 } } as never,
    };

    // While the app stands, the automation's own step lands.
    expect((await registry.execute(publish, ctx)).status).toBe("ok");

    await runtime.delete(APP_ID, ctx);

    // The app is gone, the automation is not — and this is the moment it fails.
    // The outcome is an ERROR that names the missing app, which is what the
    // engine turns into a terminal `error` run row (`run-execution.ts`'s
    // `stopped at <step>` terminal): loud, in the ledger, never invented.
    const outcome = await registry.execute(publish, ctx);
    expect(errorOf(outcome).code).toBe("not-found");
    expect(errorOf(outcome).message).toContain(APP_ID);
  });
});
