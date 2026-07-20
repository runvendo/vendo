import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApps } from "@vendoai/apps";
import { createAutomations, type AutomationsEngine } from "@vendoai/automations";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Principal,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";

// execution-v2 Wave 9 — the escalation-ladder fake-adapter e2e: "email me a
// digest of unpaid invoices at 8am" rides rung (a) end to end. The edit
// authors a STEPS automation in one model call, the EXISTING automations
// engine fires it on its schedule tick, the run's last step lands the digest
// in an app data collection, and the tree's query shows it — with ZERO
// sandbox creation (no sandbox adapter is even configured).

const principal: Principal = { kind: "user", subject: "user_e2e" };
const ctx: RunContext = {
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "session_e2e",
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Minimal deterministic LanguageModelV2 double (streamed text responses in
 *  order; the last response repeats). Local copy — the apps package's test
 *  double is internal to that package. */
const scriptedModel = (...responses: string[]): LanguageModel => {
  let calls = 0;
  const model = {
    specificationVersion: "v2" as const,
    provider: "vendo-scripted",
    modelId: "vendo-scripted-e2e",
    supportedUrls: {},
    async doGenerate() {
      const text = responses[Math.min(calls, responses.length - 1)] ?? "";
      calls += 1;
      return {
        content: [{ type: "text" as const, text }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream() {
      const text = responses[Math.min(calls, responses.length - 1)] ?? "";
      calls += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text_1" });
            controller.enqueue({ type: "text-delta", id: "text_1", delta: text });
            controller.enqueue({ type: "text-end", id: "text_1" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    },
  };
  return model as unknown as LanguageModel;
};

const APP_ID = "app_digest";

const PLAN = JSON.stringify({
  name: "Unpaid invoice digest",
  resultsCollection: "digest",
  trigger: {
    on: { kind: "schedule", cron: "0 8 * * *" },
    run: {
      kind: "steps",
      steps: [
        { id: "invoices", tool: "host_list_unpaid_invoices" },
        { id: "email", tool: "host_send_email", args: { subject: "'Unpaid invoice digest'", body: "steps.invoices.summary" } },
        { id: "publish", tool: "vendo_apps_data_put", args: { appId: `'${APP_ID}'`, collection: "'digest'", id: "'latest'", data: "steps.invoices" } },
      ],
    },
  },
});

const REBIND = `<Edit><Query id="results" tool="vendo_apps_data_list" input={{appId:"${APP_ID}", collection:"digest"}}/><Insert into="root"><Text text={results.records.0.data.summary}/></Insert></Edit>`;

const seedDoc: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: APP_ID,
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
};

async function harness(): Promise<{
  store: ReturnType<typeof createStore>;
  guard: ReturnType<typeof createGuard>;
  apps: ReturnType<typeof createApps>;
  automations: AutomationsEngine;
  emails: Array<{ subject: string; body: string }>;
}> {
  const root = await mkdtemp(join(tmpdir(), "vendo-ladder-e2e-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const store = createStore({ dataDir: join(root, ".data") });
  cleanups.push(async () => store.close());
  await store.ensureSchema();
  const guard = createGuard({ store, policy: "autopilot" });

  const emails: Array<{ subject: string; body: string }> = [];
  const hostDescriptors: ToolDescriptor[] = [
    {
      name: "host_list_unpaid_invoices",
      description: "List unpaid invoices",
      inputSchema: { type: "object", properties: {} },
      risk: "read",
    },
    {
      name: "host_send_email",
      description: "Send the user an email",
      inputSchema: {
        type: "object",
        properties: { subject: { type: "string" }, body: { type: "string" } },
        required: ["subject", "body"],
      },
      risk: "write",
    },
  ];
  // The umbrella's composition dance: the registry the runtime executes
  // through gains the apps agent tools (vendo_apps_data_*) after createApps
  // returns — exactly how server.ts wires actions.add(apps.agentTools()).
  let appsTools: ToolRegistry | undefined;
  const combined: ToolRegistry = {
    async descriptors() {
      return [...hostDescriptors, ...(appsTools === undefined ? [] : await appsTools.descriptors())];
    },
    async execute(call, callCtx) {
      if (call.tool === "host_list_unpaid_invoices") {
        return {
          status: "ok",
          output: { invoices: [{ id: "inv_1", client: "Acme", amountCents: 420000 }], summary: "1 unpaid invoice" },
        };
      }
      if (call.tool === "host_send_email") {
        emails.push(call.args as { subject: string; body: string });
        return { status: "ok", output: { sent: true } };
      }
      if (appsTools !== undefined) return appsTools.execute(call, callCtx);
      return { status: "error", error: { code: "not-found", message: `no tool ${call.tool}` } };
    },
  };
  const boundTools = guard.bind(combined);
  // The umbrella's arming seam: a ladder-authored automation is enabled
  // through automations.enable (07 §3 grant capture) the moment it is created.
  let automationsRef: AutomationsEngine | undefined;
  const apps = createApps({
    store,
    guard,
    tools: boundTools,
    catalog: [],
    model: scriptedModel(PLAN, REBIND),
    armAutomation: async (appId, armCtx) => {
      if (automationsRef === undefined) throw new Error("automations not composed");
      return automationsRef.enable(appId, armCtx);
    },
    // NO machine config at all: a sandbox is not merely unused, it does not exist.
  });
  appsTools = apps.agentTools();
  const automations = createAutomations({ apps, tools: boundTools, guard, store });
  automationsRef = automations;
  await store.records("vendo_apps").put({
    id: APP_ID,
    data: { subject: principal.subject, enabled: false, doc: seedDoc },
    refs: { subject: principal.subject },
  });
  return { store, guard, apps, automations, emails };
}

describe.sequential("Wave 9 rung (a) e2e — the 8am digest rides the automations engine, no machine anywhere", () => {
  it("edit authors+arms the automation, tick fires it, the digest lands in a store row the tree query shows", async () => {
    const { store, guard, apps, automations, emails } = await harness();

    // 1. The server-shaped instruction becomes a STEPS automation, in seconds.
    const result = await apps.edit(APP_ID, "email me a digest of unpaid invoices at 8am", ctx);
    expect(result.failure).toBeUndefined();
    expect(result.automation?.mode).toBe("steps");
    expect(result.app.trigger?.on).toEqual({ kind: "schedule", cron: "0 8 * * *" });
    expect(result.app.machine).toBeUndefined();

    // The automations engine sees it: armed, listed, schedule-triggered.
    const listed = await automations.list(ctx);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.enabled).toBe(true);

    // The arming ran the 07 §3 grant-capture flow: one standing-grant
    // approval per step tool rides the edit result. The owner approves them
    // (in-product this is the dock's approvals surface) so away runs can
    // complete unattended — an away run holds ONLY grants captured while
    // present (guard 05 §6).
    const pendingGrants = result.automation?.pendingGrants ?? [];
    expect(pendingGrants.map((request) => request.call.tool).sort()).toEqual([
      "host_list_unpaid_invoices",
      "host_send_email",
      "vendo_apps_data_put",
    ]);
    for (const request of pendingGrants) {
      await guard.approvals.decide(request.id, { approve: true }, principal);
    }

    // 2. The EXISTING trigger machinery fires it. First tick seeds the
    // schedule cursor; the next tick past 08:00 UTC fires the run.
    const seededAt = new Date("2026-07-21T00:00:00.000Z");
    expect(await automations.tick(seededAt)).toHaveLength(0);
    const runIds = await automations.tick(new Date("2026-07-21T08:00:05.000Z"));
    expect(runIds).toHaveLength(1);

    const run = await automations.runs.get(runIds[0]!, ctx);
    expect(run?.status).toBe("ok");
    expect(run?.steps.map((step) => step.outcome)).toEqual(["ok", "ok", "ok"]);

    // 3. The digest email went out and the result landed in the app's declared
    // records collection (the store rows the tree can query).
    expect(emails).toEqual([{ subject: "Unpaid invoice digest", body: "1 unpaid invoice" }]);
    const rowRecord = await store.records(`app:${APP_ID}:digest`).get("latest");
    expect(rowRecord).not.toBeNull();
    expect(JSON.stringify(rowRecord?.data)).toContain("1 unpaid invoice");

    // 4. The tree query surfaces it: open() resolves the
    // vendo_apps_data_list query and the digest summary is in the payload.
    const surface = await apps.open(APP_ID, ctx);
    expect(surface.kind).toBe("tree");
    if (surface.kind !== "tree") throw new Error("expected the tree surface");
    expect(JSON.stringify(surface.payload)).toContain("1 unpaid invoice");

    // 5. ZERO sandbox creation: the document never grew a machine (and no
    // sandbox adapter was configured to begin with).
    expect((await apps.get(APP_ID, ctx))?.machine).toBeUndefined();
  });
});
