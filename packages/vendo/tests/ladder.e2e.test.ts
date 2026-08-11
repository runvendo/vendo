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
  type WorkspaceFs,
} from "@vendoai/core";
import { escalatedPlanPath, screenAssembler } from "../src/screen-agent.js";
import { createGuard } from "@vendoai/guard";
import { createStore, workspaceStore } from "@vendoai/store";
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

/** The WHOLE prompt as text, tool results included — the assembly loop's own
 *  answers come back as tool RESULTS, and they are what say which step a run is
 *  on. */
const promptText = (call: ModelCall): string => JSON.stringify(call.prompt ?? "");

/** One turn of the assembly loop: a tool call, or the closing word. */
type Turn = { tool: string; input: unknown } | { say: string };

/**
 * Minimal deterministic LanguageModelV2 double, answering by WHICH turn it is
 * being asked (the assembly loop, the automation planner) rather than by call
 * order. Local copy — the apps package's test double is internal to that
 * package.
 */
const scriptedModel = (respond: (prompt: string) => Turn): LanguageModel => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const model = {
    specificationVersion: "v2" as const,
    provider: "vendo-scripted",
    modelId: "vendo-scripted-e2e",
    supportedUrls: {},
    async doGenerate(call: ModelCall) {
      const turn = respond(promptText(call));
      if ("say" in turn) {
        return { content: [{ type: "text" as const, text: turn.say }], finishReason: "stop" as const, usage };
      }
      return {
        content: [{
          type: "tool-call" as const,
          toolCallId: `call_${turn.tool}`,
          toolName: turn.tool,
          input: JSON.stringify(turn.input),
        }],
        finishReason: "tool-calls" as const,
        usage,
      };
    },
    async doStream(call: ModelCall) {
      const turn = respond(promptText(call));
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if ("say" in turn) {
              controller.enqueue({ type: "text-start", id: "text_1" });
              controller.enqueue({ type: "text-delta", id: "text_1", delta: turn.say });
              controller.enqueue({ type: "text-end", id: "text_1" });
              controller.enqueue({ type: "finish", finishReason: "stop", usage });
            } else {
              controller.enqueue({
                type: "tool-call",
                toolCallId: `call_${turn.tool}`,
                toolName: turn.tool,
                input: JSON.stringify(turn.input),
              });
              controller.enqueue({ type: "finish", finishReason: "tool-calls", usage });
            }
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

/** The plan the ASSEMBLER writes when it escalates: the app already exists, so
 *  this is an AMENDMENT — one small group, plus the away work no document can do
 *  in the browser, declared as `<Server kind="steps">`. That declaration is the
 *  escalating agent's own; nothing re-plans it. */
const AMENDMENT = `<Plan name="Invoice board">
  <Group title="Unpaid invoice digest">
    <Leaf component="Text" purpose="One line saying the 8am digest below is written by the automation"/>
  </Group>
  <Server kind="steps" schedule="every day at 8am" why="The digest has to go out at 8am, when nobody has the app open."/>
</Plan>`;

/** The rewire the automation lane asks for once its trigger is authored, as the
 *  ONE builder performs it: the whole document again, with a query over the
 *  results rows and a node that shows them. */
const REBOUND = `<App name="Invoice board">
  <Query id="results" tool="vendo_apps_data_list" input={{appId:"${APP_ID}", collection:"digest"}}/>
  <Stack>
    <Text text="Invoices"/>
    <Text text="Refreshed every morning by the digest automation."/>
    <Text text={results.records.0.data.summary}/>
  </Stack>
</App>`;

/** The planner's FIRST answer: the person asked to be emailed, so the model
 *  reaches for the send tool. §12 refuses that at authoring time now — a send is
 *  not a thing Vendo does while nobody is watching — and the refusal rides back
 *  as the repair instruction. */
const PLAN_WITH_SEND = JSON.stringify({
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

/** The repair the refusal asks for, and the reason the refusal doubles as the
 *  repair instruction: the away-safe HALF of the same request — read the live
 *  data, publish the digest to the board — with the send left to the person. */
const PLAN_AWAY_SAFE = JSON.stringify({
  name: "Unpaid invoice digest",
  resultsCollection: "digest",
  trigger: {
    on: { kind: "schedule", cron: "0 8 * * *" },
    run: {
      kind: "steps",
      steps: [
        { id: "invoices", tool: "host_list_unpaid_invoices" },
        { id: "publish", tool: "vendo_apps_data_put", args: { appId: `'${APP_ID}'`, collection: "'digest'", id: "'latest'", data: "steps.invoices" } },
      ],
    },
  },
});

/** The assembly loop's own brief (`environmentNote`) — the one marker that says a
 *  prompt belongs to the ONE builder. Both the edit and the lane's rewire ride
 *  it, so what tells them apart is the instruction each carries. */
const SCREEN_BRIEF_MARKER = "# In this loop";
/** The rewire instruction's own opening (`automationResultsInstruction`). */
const REBIND_MARKER = "The app now has a steps automation";
/** The two hands' own replies. A tool RESULT in the prompt means this run has
 *  already played its one move, and the only thing left is to stop talking. */
const SAVED_MARKER = "Run validate on it now.";
const HANDED_OVER_MARKER = "handedOver";

/** Which turn this is, and what it answers. The AI reviewer rides the same model
 *  and gets nothing, which is how a fixture with no findings says so. */
const respond = (prompt: string): Turn => {
  if (prompt.includes("You are the Vendo automation planner")) {
    return { say: prompt.includes("REPAIR_THESE_ISSUES") ? PLAN_AWAY_SAFE : PLAN_WITH_SEND };
  }
  if (!prompt.includes(SCREEN_BRIEF_MARKER)) return { say: "" };
  if (prompt.includes(SAVED_MARKER) || prompt.includes(HANDED_OVER_MARKER)) return { say: "done" };
  // The lane's rewire: one more assembler turn over the app as it stands.
  if (prompt.includes(REBIND_MARKER)) return { tool: "save_app", input: { content: REBOUND } };
  // The edit itself: assembling a document cannot make something happen at 8am
  // while nobody is watching, so the one door out is taken — and the plan says
  // which lane the work runs in.
  return {
    tool: "escalate",
    input: { plan: AMENDMENT, why: "the digest has to run at 8am with nobody watching, which no document can do" },
  };
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
  // The ONE builder, composed exactly as `createVendo` composes it: the real
  // assembly loop over the real workspace, landing through the real render seam
  // (`authored` + the checks floor). An edit has no second engine behind it, so
  // a stub here would prove nothing about the ladder it hands off to.
  const model = scriptedModel(respond);
  const workspaces = workspaceStore(store);
  const screenWorkspace = async (screenCtx: RunContext): Promise<WorkspaceFs> =>
    await workspaces.open(screenCtx.principal);
  let appsRef: ReturnType<typeof createApps> | undefined;
  const apps = createApps({
    store,
    guard,
    tools: boundTools,
    catalog: [],
    model,
    screen: screenAssembler({
      models: { default: model },
      tools: boundTools,
      workspace: screenWorkspace,
      render: (screenCtx) => ({
        authoredApp: (input) => appsRef!.authored(input, screenCtx),
        commitSource: (input) => appsRef!.commitSource(input, screenCtx),
        floor: appsRef!.floor(screenCtx),
      }),
      remember: async (appId, decisions, memoryCtx) => {
        await appsRef!.remember({ appId, decisions }, memoryCtx);
      },
    }),
    // §4.5's receiving end: the plan the escalating run wrote, read back out of
    // the SAME workspace it wrote it to.
    escalatedPlan: async (appId, planCtx) => {
      const workspace = await screenWorkspace(planCtx).catch(() => undefined);
      if (workspace === undefined) return undefined;
      const source = await workspace.readFile(escalatedPlanPath(appId)).catch(() => undefined);
      return typeof source === "string" && source.trim() !== "" ? source : undefined;
    },
    armAutomation: async (appId, triggerId, armCtx) => {
      if (automationsRef === undefined) throw new Error("automations not composed");
      return automationsRef.enable(appId, triggerId, armCtx);
    },
    // NO machine config at all: a sandbox is not merely unused, it does not exist.
  });
  appsRef = apps;
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
  it("edit authors+arms the away-safe half of the ask, and the tick fires it onto the board", async () => {
    const { guard, apps, automations, emails } = await harness();

    // 1. The server-shaped instruction becomes a STEPS automation, in seconds.
    //    The ask names a send, so the planner's first answer does too, and §12
    //    refuses it AT AUTHORING — the refusal doubles as the repair, and what
    //    lands is the half that can run away (read, then publish).
    const result = await apps.edit(APP_ID, "email me a digest of unpaid invoices at 8am", ctx);
    expect(result.failure).toBeUndefined();
    expect(result.automation?.mode).toBe("steps");
    expect(result.app.triggers?.[0]?.on).toEqual({ kind: "schedule", cron: "0 8 * * *" });
    expect(result.app.machine).toBeUndefined();

    // The automations engine sees it: armed, listed, schedule-triggered.
    const listed = await automations.list(ctx);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.triggers[0]?.enabled).toBe(true);

    // The arming ran the 07 §3 grant-capture flow: one standing-grant
    // approval per step tool rides the edit result. The owner approves them
    // (in-product this is the dock's approvals surface) so away runs can
    // complete unattended — an away run holds ONLY grants captured while
    // present (guard 05 §6).
    //
    // This list is also where the authoring refusal shows: `host_send_email` is
    // NOT here, because it never became part of the automation. A law that had
    // stopped working would put it back — the first plan named it.
    const pendingGrants = result.automation?.pendingGrants ?? [];
    expect(pendingGrants.map((request) => request.call.tool).sort()).toEqual([
      "host_list_unpaid_invoices",
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

    // 3. The away run completes: it read the live invoices and published the
    //    digest. Automations are not crippled by §12 — only stopped short of
    //    irreversibility, which this one was never authored to reach.
    const run = await automations.runs.get(runIds[0]!, ctx);
    expect(run?.status).toBe("ok");
    expect(run?.steps.map((step) => [step.tool, step.outcome])).toEqual([
      ["host_list_unpaid_invoices", "ok"],
      ["vendo_apps_data_put", "ok"],
    ]);

    // 4. Nothing was sent. This is the assertion the whole law exists for — and
    //    the law now keeps it by never authoring the send, rather than by
    //    letting one land and refusing it on every firing forever. The fire-time
    //    refusal is still there as defence in depth, proved over the real guard
    //    in guard/test/security/unattended-destructive.test.ts (audit trail
    //    included) and over the whole stack in law-projection.e2e.test.ts; the
    //    authoring refusal itself is proved in
    //    fixtures/automations-e2e/src/automation-refusal.e2e.test.ts.
    expect(emails).toEqual([]);

    // 5. The board shows what the away run did. A run whose result nobody can
    //    see did not happen: the trigger's last step wrote the digest into its
    //    declared collection, and the rewired tree's query resolves those rows
    //    into the rendered payload.
    const surface = await apps.open(APP_ID, ctx);
    expect(surface.kind).toBe("tree");
    expect(JSON.stringify(surface)).toContain("1 unpaid invoice");

    // 6. ZERO sandbox creation: the document never grew a machine (and no
    //    sandbox adapter was configured to begin with).
    expect((await apps.get(APP_ID, ctx))?.machine).toBeUndefined();

    // NOTE: prepare-then-human-sends (the outbox that turns "I couldn't author
    // the send" into "your digest is ready · [Send]") arrives with the
    // automations pack, on its own track.
  });

  it("resolves the rewired query over rows written straight into the collection", async () => {
    // The same round trip as step 5 above, minus the run: whatever puts a row in
    // the declared collection, open() resolves the vendo_apps_data_list query
    // over those rows into the rendered payload. Narrower on purpose — it keeps
    // the query-resolution half honest even if the away run stops firing.
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
