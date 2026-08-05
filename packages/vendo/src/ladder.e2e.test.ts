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

interface ModelCall {
  prompt: Array<{ role: string; content: string | Array<{ type?: string; text?: string }> }>;
}

const promptText = (call: ModelCall): string => call.prompt
  .map((message) => typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.text ?? "").join(""))
  .join("\n");

/** Minimal deterministic LanguageModelV2 double, answering by WHICH turn it is
 *  being asked (the brain, a fill worker, the automation planner) rather than by
 *  call order — the rebuilt pipeline interleaves all three. Local copy — the
 *  apps package's test double is internal to that package. */
const scriptedModel = (respond: (prompt: string) => string): LanguageModel => {
  const model = {
    specificationVersion: "v2" as const,
    provider: "vendo-scripted",
    modelId: "vendo-scripted-e2e",
    supportedUrls: {},
    async doGenerate(call: ModelCall) {
      return {
        content: [{ type: "text" as const, text: respond(promptText(call)) }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream(call: ModelCall) {
      const text = respond(promptText(call));
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

// The engine's pinned clock (see harness): arming seeds the schedule cursor
// at this instant, so the cron's next fire is deterministically the following
// 08:00 UTC — independent of when the suite actually runs.
const ARMED_AT = new Date("2026-07-21T12:00:00.000Z");
const FIRES_AT = new Date("2026-07-22T08:00:05.000Z");

/** The brain's answer to the server-shaped instruction: the app already exists,
 *  so this is an AMENDMENT — one small group, plus the away work it cannot do in
 *  the browser, declared as `<Server kind="steps">`. */
const AMENDMENT = `<Plan name="Invoice board">
  <Group title="Unpaid invoice digest">
    <Leaf component="Text" purpose="One line saying the 8am digest below is written by the automation"/>
  </Group>
  <Server kind="steps" schedule="every day at 8am" why="The digest has to go out at 8am, when nobody has the app open."/>
</Plan>`;

/** The fill worker's section: static text, because this group reads no query. */
const FILL = '<Text text="Refreshed every morning by the digest automation."/>';

const APP_AS_IT_STANDS = "THE APP AS IT STANDS — the only true copy of it, and what an <Old> must quote:\n";

/** The app exactly as the brain was shown it. */
const printedApp = (prompt: string): string => {
  const at = prompt.indexOf(APP_AS_IT_STANDS);
  if (at === -1) return "";
  return prompt.slice(at + APP_AS_IT_STANDS.length).split("\n\nTHEY ARE ASKING NOW:")[0] ?? "";
};

/** The rewire the automation lane asks for once its trigger is authored: the app
 *  as it stands, plus a query over the results rows and a node that shows them.
 *  Written whole (the `direct` answer) so it never depends on quoting text the
 *  fill happened to produce. */
const REBIND = (prompt: string): string => {
  const printed = printedApp(prompt);
  const firstLine = printed.indexOf("\n");
  return [
    printed.slice(0, firstLine),
    `  <Query id="results" tool="vendo_apps_data_list" input={{appId:"${APP_ID}", collection:"digest"}}/>`,
    "  <Text text={results.records.0.data.summary}/>",
  ].join("\n") + printed.slice(firstLine);
};

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

/** Which turn this is, and what it answers. The AI reviewer rides the same model
 *  and gets nothing, which is how a fixture with no findings says so. */
const respond = (prompt: string): string => {
  if (prompt.includes("You are the Vendo automation planner")) return PLAN;
  if (prompt.includes("YOUR SECTION")) return FILL;
  if (!prompt.includes("THEY ARE ASKING NOW:")) return "";
  return prompt.includes("THEY ARE ASKING NOW: The app now has a steps automation") ? REBIND(prompt) : AMENDMENT;
};

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
      // Messaging a human is destructive, and the dev's label is final (two-vote
      // grading removed) — this label is what THE LAW's refusal below rests on.
      risk: "destructive",
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
    model: scriptedModel(respond),
    armAutomation: async (appId, armCtx) => {
      if (automationsRef === undefined) throw new Error("automations not composed");
      return automationsRef.enable(appId, armCtx);
    },
    // NO machine config at all: a sandbox is not merely unused, it does not exist.
  });
  appsTools = apps.agentTools();
  // Deterministic clock: enable() seeds the schedule cursor with the engine's
  // now(), so pinning it decouples the whole test from the wall clock — no
  // boundary window even when the suite runs exactly at the cron hour.
  const automations = createAutomations({ apps, tools: boundTools, guard, store, now: () => ARMED_AT });
  automationsRef = automations;
  await store.records("vendo_apps").put({
    id: APP_ID,
    data: { subject: principal.subject, enabled: false, doc: seedDoc },
    refs: { subject: principal.subject },
  });
  return { store, guard, apps, automations, emails };
}

describe.sequential("Wave 9 rung (a) e2e — the 8am digest rides the automations engine, no machine anywhere", () => {
  it("edit authors+arms the automation, tick fires it, and THE LAW refuses its unattended email", async () => {
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

    // 2. The EXISTING trigger machinery fires it. Arming seeded the schedule
    // cursor at the engine's PINNED clock (ARMED_AT — hardcoded wall-clock
    // dates here were a date-bomb that went red the moment real time passed
    // the cron hour, and deriving from the real clock still left a boundary
    // window). A tick at the pinned instant fires nothing (the next 08:00 UTC
    // is still ahead of the cursor); a tick just past that fire time fires
    // exactly one run.
    expect(await automations.tick(ARMED_AT)).toHaveLength(0);
    const runIds = await automations.tick(FIRES_AT);
    expect(runIds).toHaveLength(1);

    // 3. THE LAW (design §12): destructive and external actions are never
    //    unattended. `host_send_email` messages a human, so an unattended run
    //    may not perform it — not with a standing grant, not with the owner's
    //    approval captured above, not with any limit or override. The run fails
    //    LOUDLY rather than skipping the step and reporting success.
    const run = await automations.runs.get(runIds[0]!, ctx);
    expect(run?.status).toBe("error");

    const email = run?.steps.find((step) => step.tool === "host_send_email");
    expect(email?.outcome).toBe("blocked");
    expect(email?.detail).toContain("destructive or external");

    // The read before it still ran — automations are not crippled, only stopped
    // short of irreversibility.
    expect(run?.steps.find((step) => step.tool === "host_list_unpaid_invoices")?.outcome).toBe("ok");

    // 4. Nothing was sent. This is the assertion the whole law exists for.
    expect(emails).toEqual([]);

    // 5. The refusal is in the audit trail, which is what the run history and
    //    the failure card on the app surface render from (§13 — a render, not
    //    new machinery). A silent failure would leave the owner with an app
    //    that quietly stopped working.
    const { events } = await guard.audit.query({ principal, limit: 100 });
    expect(events.some((event) =>
      event.tool === "host_send_email" && event.outcome === "blocked")).toBe(true);

    // 6. ZERO sandbox creation: the document never grew a machine (and no
    //    sandbox adapter was configured to begin with).
    expect((await apps.get(APP_ID, ctx))?.machine).toBeUndefined();

    // NOTE: prepare-then-human-sends (the outbox that turns this refusal into
    // "your digest is ready · [Send]") arrives with the automations pack, on its
    // own track. The wave-1 truth asserted here is the refusal itself.
  });

  it("still round-trips a records put into the tree query, which the refusal test no longer reaches", async () => {
    // Coverage the pre-law version of the test above uniquely carried: an
    // automation writing to its declared collection, and open() resolving the
    // vendo_apps_data_list query over those rows into the rendered payload. The
    // refusal now aborts the run before the publish step, so this exercises the
    // same round trip directly rather than letting the coverage vanish.
    const { store, apps } = await harness();
    await apps.edit(APP_ID, "email me a digest of unpaid invoices at 8am", ctx);

    await store.records(`app:${APP_ID}:digest`).put({
      id: "latest",
      data: { summary: "1 unpaid invoice" },
    });

    const surface = await apps.open(APP_ID, ctx);
    expect(surface.kind).toBe("tree");
    if (surface.kind !== "tree") throw new Error("expected the tree surface");
    expect(JSON.stringify(surface.payload)).toContain("1 unpaid invoice");
  });
});
