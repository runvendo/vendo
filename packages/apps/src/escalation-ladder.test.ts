import { VENDO_APP_FORMAT, VendoError, type AppDocument, type RunContext, type ToolDescriptor, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { serverWorkRung } from "./engine.js";
import { createApps } from "./index.js";
import { fakeBoxSandbox, type FakeBoxAgent } from "./testing/fake-box.js";
import { guardFixture, memoryStore, scriptedLanguageModel, seedAppRow } from "./testing/index.js";

/**
 * execution-v2 Wave 9 — the server-work escalation ladder and the
 * experimentalMachines opt-in. Server-shaped instructions prefer, in order:
 * (a) a STEPS automation (deterministic tool calls on the existing automations
 * engine — setup in seconds, no machine), (b) an AGENTIC automation (per-run
 * judgment, still tool-reachable), (c) BOX graduation (custom code), which is
 * experimental and gated like served apps.
 */

const ctx = (subject = "user_ada"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

const treeApp = (id = "app_ladder", overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Invoice board",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["title"] },
      { id: "title", component: "Text", source: "prewired", props: { text: "Invoices" } },
    ],
  } as AppDocument["tree"],
  ...overrides,
});

const descriptor = (name: string, risk: "read" | "write", required: string[] = []): ToolDescriptor => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object", properties: {}, ...(required.length === 0 ? {} : { required }) },
  risk,
});

/** Host tools plus the vendo_apps_data_* pair the ladder's results pattern rides. */
const ladderTools = (): ToolRegistry => {
  const descriptors = [
    descriptor("host_list_unpaid_invoices", "read"),
    descriptor("host_send_email", "write", ["subject", "body"]),
    descriptor("vendo_apps_data_put", "write", ["appId", "collection", "id", "data"]),
    descriptor("vendo_apps_data_list", "read", ["appId", "collection"]),
  ];
  return {
    async descriptors() { return structuredClone(descriptors); },
    async execute(call) {
      if (call.tool === "host_list_unpaid_invoices") {
        return { status: "ok", output: { invoices: [{ id: "inv_1", client: "Acme", amountCents: 420000 }], summary: "1 unpaid invoice" } };
      }
      return { status: "error", error: { code: "not-found", message: `no tool ${call.tool}` } };
    },
  };
};

/** The plan the scripted model returns for the 8am digest instruction. */
const DIGEST_PLAN = JSON.stringify({
  name: "Unpaid invoice digest",
  resultsCollection: "digest",
  trigger: {
    on: { kind: "schedule", cron: "0 8 * * *" },
    run: {
      kind: "steps",
      steps: [
        { id: "invoices", tool: "host_list_unpaid_invoices" },
        { id: "email", tool: "host_send_email", args: { subject: "'Unpaid invoice digest'", body: "steps.invoices.summary" } },
        { id: "publish", tool: "vendo_apps_data_put", args: { appId: "'app_ladder'", collection: "'digest'", id: "'latest'", data: "steps.invoices" } },
      ],
    },
  },
});

const NUDGE_PLAN = JSON.stringify({
  name: "Invoice nudge triage",
  trigger: {
    on: { kind: "schedule", every: "1d" },
    run: { kind: "agentic", prompt: "Review unpaid invoices, decide who deserves a gentle vs firm nudge, draft and send accordingly.", budget: { maxToolCalls: 20 } },
  },
});

/** The tree rebind that binds the automation's results collection. */
const RESULTS_REBIND_EDIT = '<Edit><Query id="results" tool="vendo_apps_data_list" input={{appId:"app_ladder", collection:"digest"}}/><Insert into="root"><Text text={results.records.0.data.summary}/></Insert></Edit>';

/** A box agent for the flag-on box-rung case (same shape as graduation.test.ts). */
const ledgerAgent: FakeBoxAgent = ({ box }) => {
  box.fns.set("getLedger", () => ({ rows: 3 }));
  box.manifest = {};
  return { ok: true, summary: "wrote reconciliation ledger", filesChanged: ["/app/server.js"], testsRun: 1, fns: ["getLedger"] };
};

const LEDGER_REBIND_EDIT = '<Edit><Query id="ledger" tool="fn:getLedger"/><Insert into="root"><Text text={ledger.rows}/></Insert></Edit>';

const setup = (options: {
  responses?: Parameters<typeof scriptedLanguageModel>;
  experimentalMachines?: boolean;
  agent?: FakeBoxAgent;
} = {}) => {
  const store = memoryStore();
  const guard = guardFixture();
  const sandbox = fakeBoxSandbox({ agent: options.agent ?? ledgerAgent });
  const runtime = createApps({
    store,
    guard,
    tools: ladderTools(),
    catalog: [],
    model: scriptedLanguageModel(...(options.responses ?? [DIGEST_PLAN, RESULTS_REBIND_EDIT])),
    ...(options.experimentalMachines === undefined ? {} : { experimentalMachines: options.experimentalMachines }),
    machine: { sandbox, buildEnv: () => ({ PORT: "8080" }), boxEditPollMs: 5 },
  });
  return { store, guard, sandbox, runtime };
};

describe("serverWorkRung — the escalation-ladder judge", () => {
  const app = { ui: "tree" } as Pick<AppDocument, "ui">;

  it("routes deterministic tool-shaped schedule work to a STEPS automation", () => {
    expect(serverWorkRung(app, "email me a digest of unpaid invoices at 8am")).toBe("steps");
  });

  it("routes per-run judgment that is still tool-reachable to an AGENTIC automation", () => {
    expect(serverWorkRung(app, "decide who deserves a gentle vs firm nudge and draft accordingly")).toBe("agentic");
  });

  it("routes custom-code work (real computation, persistent app state) to the BOX", () => {
    expect(serverWorkRung(app, "parse uploaded CSVs with custom dedup logic and keep a reconciliation ledger")).toBe("box");
  });

  it("box signals outrank agentic signals: judgment plus custom code needs the box", () => {
    expect(serverWorkRung(app, "decide which rows to keep using custom dedup logic")).toBe("box");
  });

  it("stays off the ladder for pure-UI instructions", () => {
    expect(serverWorkRung(app, "make the status board heading blue")).toBeNull();
  });

  it("keeps the ENG-349 visible-element rule: ladder words labeling an element stay on the tree path", () => {
    expect(serverWorkRung(app, "make the parse errors card blue")).toBeNull();
    expect(serverWorkRung(app, "rename the daily digest card")).toBeNull();
  });
});

describe("rung (a): steps automation — setup in seconds, no machine", () => {
  it("authors, persists, and arms a steps automation; the sandbox is never touched", async () => {
    const { store, sandbox, runtime } = setup();
    await seedAppRow(store, treeApp(), "user_ada");

    const result = await runtime.edit("app_ladder", "email me a digest of unpaid invoices at 8am", ctx());

    expect(result.failure).toBeUndefined();
    expect(result.automation?.mode).toBe("steps");
    // The trigger rides the EXISTING automations document model.
    expect(result.app.trigger?.on).toEqual({ kind: "schedule", cron: "0 8 * * *" });
    expect(result.app.trigger?.run.kind).toBe("steps");
    // No box anywhere: no machine on the doc, no sandbox machine created.
    expect(result.app.machine).toBeUndefined();
    expect(result.graduated).toBeUndefined();
    expect(sandbox.machines).toHaveLength(0);
    // The results collection is declared so its rows are tree-queryable.
    expect(result.app.storage?.digest?.kind).toBe("records");
    // Armed: the stored row is enabled with the trigger_kind ref the tick uses.
    const row = await store.records("vendo_apps").get("app_ladder");
    expect((row?.data as { enabled?: boolean }).enabled).toBe(true);
    expect(row?.refs?.trigger_kind).toBe("schedule");
    // The tree gained a query over the automation's results rows.
    const tree = result.app.tree as { queries?: Array<{ tool: string }> };
    expect(tree.queries?.some((query) => query.tool === "vendo_apps_data_list")).toBe(true);
  });

  it("rejects a plan that declares a results collection no step publishes, then accepts the repair", async () => {
    const unpublished = JSON.stringify({
      resultsCollection: "digest",
      trigger: {
        on: { kind: "schedule", cron: "0 8 * * *" },
        run: { kind: "steps", steps: [{ id: "invoices", tool: "host_list_unpaid_invoices" }] },
      },
    });
    const { store, runtime } = setup({ responses: [unpublished, DIGEST_PLAN, RESULTS_REBIND_EDIT] });
    await seedAppRow(store, treeApp(), "user_ada");

    const result = await runtime.edit("app_ladder", "email me a digest of unpaid invoices at 8am", ctx());

    expect(result.failure).toBeUndefined();
    // The accepted repair publishes into the declared collection.
    const steps = (result.app.trigger?.run as { steps: Array<{ tool: string }> }).steps;
    expect(steps.some((step) => step.tool === "vendo_apps_data_put")).toBe(true);
  });

  it("rejects a plan whose steps name unknown tools, then accepts the repair", async () => {
    const badPlan = JSON.stringify({
      trigger: {
        on: { kind: "schedule", cron: "0 8 * * *" },
        run: { kind: "steps", steps: [{ id: "x", tool: "host_not_a_tool" }] },
      },
    });
    let repairSawUnknownTool = false;
    const { store, runtime } = setup({
      responses: [
        badPlan,
        (call) => {
          const text = call.prompt.map((message) => typeof message.content === "string"
            ? message.content
            : message.content.map((part) => part.text ?? "").join("")).join("\n");
          if (text.includes("host_not_a_tool")) repairSawUnknownTool = true;
          return DIGEST_PLAN;
        },
        RESULTS_REBIND_EDIT,
      ],
    });
    await seedAppRow(store, treeApp(), "user_ada");

    const result = await runtime.edit("app_ladder", "email me a digest of unpaid invoices at 8am", ctx());

    expect(result.failure).toBeUndefined();
    expect(result.app.trigger?.run.kind).toBe("steps");
    expect(repairSawUnknownTool).toBe(true);
  });
});

describe("the arming seam (AppsConfig.armAutomation)", () => {
  it("arms through the seam when wired, and its captured approvals ride the result", async () => {
    const store = memoryStore();
    const armed: string[] = [];
    const missing = [{
      id: "apr_capture_1",
      call: { id: "call_capture_1", tool: "host_send_email", args: {} },
      descriptor: descriptor("host_send_email", "write", ["subject", "body"]),
      inputPreview: "standing grant",
      ctx: { principal: { kind: "user" as const, subject: "user_ada" }, venue: "automation" as const, presence: "present" as const, appId: "app_ladder" },
      createdAt: new Date().toISOString(),
    }];
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: ladderTools(),
      catalog: [],
      model: scriptedLanguageModel(DIGEST_PLAN, RESULTS_REBIND_EDIT),
      armAutomation: async (appId) => {
        armed.push(appId);
        return { enabled: true, missing };
      },
    });
    await seedAppRow(store, treeApp(), "user_ada");

    const result = await runtime.edit("app_ladder", "email me a digest of unpaid invoices at 8am", ctx());

    expect(result.failure).toBeUndefined();
    expect(armed).toEqual(["app_ladder"]);
    expect(result.automation?.pendingGrants?.map((request) => request.call.tool)).toEqual(["host_send_email"]);
    // The seam owns arming: the direct-arm write is skipped (the seam's
    // enable() is what flips the row in production).
    const row = await store.records("vendo_apps").get("app_ladder");
    expect((row?.data as { enabled?: boolean }).enabled).toBe(false);
  });

  it("a failed seam never leaves a silently dead automation: the miss is reported", async () => {
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: ladderTools(),
      catalog: [],
      model: scriptedLanguageModel(DIGEST_PLAN, RESULTS_REBIND_EDIT),
      armAutomation: async () => { throw new VendoError("validation", "unknown tool in automation: host_send_email"); },
    });
    await seedAppRow(store, treeApp(), "user_ada");

    const result = await runtime.edit("app_ladder", "email me a digest of unpaid invoices at 8am", ctx());

    expect(result.failure).toBeUndefined();
    expect(result.app.trigger).toBeDefined();
    expect(result.issues?.some((issue) => issue.includes("arming it failed"))).toBe(true);
  });
});

describe("rung (b): agentic automation — per-run judgment, still no machine", () => {
  it("authors and arms an agentic automation", async () => {
    const { store, sandbox, runtime } = setup({ responses: [NUDGE_PLAN] });
    await seedAppRow(store, treeApp(), "user_ada");

    const result = await runtime.edit(
      "app_ladder",
      "decide who deserves a gentle vs firm nudge and draft accordingly",
      ctx(),
    );

    expect(result.failure).toBeUndefined();
    expect(result.automation?.mode).toBe("agentic");
    expect(result.app.trigger?.run.kind).toBe("agentic");
    expect(result.app.machine).toBeUndefined();
    expect(sandbox.machines).toHaveLength(0);
    const row = await store.records("vendo_apps").get("app_ladder");
    expect((row?.data as { enabled?: boolean }).enabled).toBe(true);
  });
});

describe("rung (c): box graduation — experimental, gated by experimentalMachines", () => {
  const BOX_INSTRUCTION_TEXT = "parse uploaded CSVs with custom dedup logic and keep a reconciliation ledger";

  it("flag OFF (default): a box-rung edit refuses with a typed VendoError naming the flag", async () => {
    const { store, sandbox, runtime } = setup();
    await seedAppRow(store, treeApp(), "user_ada");

    await expect(runtime.edit("app_ladder", BOX_INSTRUCTION_TEXT, ctx())).rejects.toMatchObject({
      name: "VendoError",
      code: "not-implemented",
      detail: { experiment: "machines", flag: "experimentalMachines" },
    });
    // Never a silent degrade: no machine, no automation, no box work.
    expect(sandbox.machines).toHaveLength(0);
    const row = await store.records("vendo_apps").get("app_ladder");
    expect(((row?.data as { doc?: AppDocument }).doc)?.trigger).toBeUndefined();
  });

  it("flag OFF (default): a box-rung create refuses the same way", async () => {
    const { sandbox, runtime } = setup();

    await expect(runtime.create({ prompt: BOX_INSTRUCTION_TEXT }, ctx())).rejects.toMatchObject({
      name: "VendoError",
      code: "not-implemented",
      detail: { experiment: "machines", flag: "experimentalMachines" },
    });
    expect(sandbox.machines).toHaveLength(0);
  });

  it("flag ON: the same instruction graduates through the box", async () => {
    const { store, runtime, sandbox } = setup({
      experimentalMachines: true,
      responses: [LEDGER_REBIND_EDIT],
    });
    await seedAppRow(store, treeApp(), "user_ada");

    const result = await runtime.edit("app_ladder", BOX_INSTRUCTION_TEXT, ctx());

    expect(result.failure).toBeUndefined();
    expect(result.graduated).toBe(true);
    expect(result.app.machine?.snapshotRef).toMatch(/^fakebox:/);
    expect(sandbox.machines.length).toBeGreaterThanOrEqual(1);
  });

  it("flag OFF: machine.provision on a machine-less app refuses with the typed error", async () => {
    const { store, runtime } = setup();
    await seedAppRow(store, treeApp(), "user_ada");

    await expect(runtime.machine.provision("app_ladder", ctx())).rejects.toMatchObject({
      name: "VendoError",
      code: "not-implemented",
      detail: { experiment: "machines", flag: "experimentalMachines" },
    });
  });
});

describe("experimental relationship: served apps require machines", () => {
  it("createApps refuses experimentalServedApps without experimentalMachines", () => {
    const store = memoryStore();
    expect(() => createApps({
      store,
      guard: guardFixture(),
      tools: ladderTools(),
      catalog: [],
      experimentalServedApps: true,
    })).toThrow(/experimentalMachines/);
  });

  it("createApps accepts both flags together", () => {
    const store = memoryStore();
    expect(() => createApps({
      store,
      guard: guardFixture(),
      tools: ladderTools(),
      catalog: [],
      experimentalServedApps: true,
      experimentalMachines: true,
    })).not.toThrow();
  });
});

describe("already-graduated apps are never stranded by the flag", () => {
  const provisionThenFlagOff = async () => {
    const store = memoryStore();
    const guard = guardFixture();
    const sandbox = fakeBoxSandbox({ agent: ledgerAgent });
    const machineConfig = { sandbox, buildEnv: () => ({ PORT: "8080" }), boxEditPollMs: 5 };
    const flagOn = createApps({
      store,
      guard,
      tools: ladderTools(),
      catalog: [],
      model: scriptedLanguageModel(LEDGER_REBIND_EDIT),
      experimentalMachines: true,
      machine: machineConfig,
    });
    await seedAppRow(store, treeApp(), "user_ada");
    await flagOn.machine.provision("app_ladder", ctx());
    // A NEW runtime over the same store with the flag OFF (the "flag flipped
    // off under existing apps" scenario).
    const flagOff = createApps({
      store,
      guard,
      tools: ladderTools(),
      catalog: [],
      model: scriptedLanguageModel(LEDGER_REBIND_EDIT),
      machine: machineConfig,
    });
    return { store, sandbox, flagOff };
  };

  it("a box-rung server edit on an app WITH a machine still rides the box (no refusal)", async () => {
    const { flagOff } = await provisionThenFlagOff();

    const result = await flagOff.edit(
      "app_ladder",
      "rebuild the reconciliation ledger parser with custom dedup logic",
      ctx(),
    );

    expect(result.failure).toBeUndefined();
    expect(result.graduated).toBe(true);
  });

  it("machine.wake and machine.editApp keep working on an existing machine with the flag off", async () => {
    const { flagOff } = await provisionThenFlagOff();

    await expect(flagOff.machine.wake("app_ladder", ctx())).resolves.toBeDefined();
    const outcome = await flagOff.machine.editApp("app_ladder", "tighten the dedup pass", ctx());
    expect(outcome.ok).toBe(true);
  });

  it("machine.provision stays idempotent on an already-provisioned app with the flag off", async () => {
    const { flagOff } = await provisionThenFlagOff();

    const doc = await flagOff.machine.provision("app_ladder", ctx());
    expect(doc.machine?.snapshotRef).toMatch(/^fakebox:/);
  });
});

describe("agentToolRisk reflects the ladder", () => {
  it("labels an automation-shaped edit as write even without classic server words", async () => {
    const { store, runtime } = setup();
    await seedAppRow(store, treeApp(), "user_ada");

    const risk = await runtime.agentToolRisk({
      id: "call_1",
      tool: "vendo_apps_edit",
      args: { appId: "app_ladder", instruction: "decide who deserves a gentle vs firm nudge and draft accordingly" },
    }, ctx());

    expect(risk).toBe("write");
  });

  it("still labels a pure-UI edit as read", async () => {
    const { store, runtime } = setup();
    await seedAppRow(store, treeApp(), "user_ada");

    const risk = await runtime.agentToolRisk({
      id: "call_2",
      tool: "vendo_apps_edit",
      args: { appId: "app_ladder", instruction: "make the heading blue" },
    }, ctx());

    expect(risk).toBe("read");
  });
});

describe("EditResult.automation is typed", () => {
  it("VendoError shape sanity (the ladder's refusal is a real VendoError)", () => {
    const error = new VendoError("not-implemented", "machines are experimental", { flag: "experimentalMachines" });
    expect(error.code).toBe("not-implemented");
  });
});
