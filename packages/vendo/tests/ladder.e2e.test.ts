/**
 * THE ESCALATION LADDER, end to end, on a real composed deployment.
 *
 * There is exactly ONE rung left: the box. The screen agent decides that
 * assembling a screen out of this product's components cannot serve the ask and
 * escalates with ONE sentence — no plan document, no compiled plan, no skeleton
 * to watch. So the ladder is two facts and this file proves both, through the
 * real doors on a real store:
 *
 *  - escalate WITH a sandbox BUILDS. The box is handed the person's ORIGINAL
 *    words verbatim plus that one line about why the browser cannot do it, and
 *    nothing re-plans either of them on the way.
 *  - escalate with NO sandbox REFUSES, up front, and the stored app is untouched.
 *
 * Both doors read the same gate (`lifecycle.available()`), which is why create
 * and edit are both here. A create that escalates stores a row with NO tree and
 * paints NOTHING until the box builds — an escalation is no longer a picture of
 * an app arriving in seconds.
 *
 * The MODEL and the sandbox PROVIDER are the only doubles, and neither is a side
 * of the seam under test: the assembler, the front doors, the store, the guard
 * and the box wire are all the shipped ones.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApps, type SandboxAdapter, type SandboxMachine } from "@vendoai/apps";
import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type Principal,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
  type VendoViewPart,
  type WorkspaceFs,
} from "@vendoai/core";
import { screenAssembler } from "../src/screen-agent.js";
import { createGuard } from "@vendoai/guard";
import { createStore, workspaceStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";

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
 * being asked rather than by call order. Local copy — the apps package's test
 * double is internal to that package.
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

const APP_ID = "app_matcher";

/** The person's own words, in both doors. Asserted VERBATIM in the box's brief:
 *  the escalation adds one line, it does not paraphrase the ask. */
const ASK = "match my invoices against payments and show me what didn't clear";
/** The one sentence the escalating agent hands over. There is nothing else. */
const WHY = "this needs real matching code that cannot run in the browser";

/** The assembly loop's own brief (`environmentNote`) — the one marker that says a
 *  prompt belongs to the ONE builder, without counting model calls. */
const SCREEN_BRIEF_MARKER = "# In this loop";
/** The escalate hand's own reply. A tool RESULT in the prompt means this run has
 *  already played its one move, and the only thing left is to stop talking. */
const HANDED_OVER_MARKER = "handedOver";

// ── the fake box ─────────────────────────────────────────────────────────────
// The control port 8811 and the `/agent/task` long-poll, and nothing more than
// these tests read: the PROMPT it was handed. `@vendoai/apps`' box substrate is
// not on that package's exports map, so this is the local one.

const BOX_CONTROL_PORT = 8811;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface BoxLog {
  created: number;
  /** The brief every task carried — where `boxInstruction`'s output lands. */
  prompts: string[];
}

function fakeBox(log: BoxLog): SandboxAdapter {
  const tasks = new Map<string, { status: "done"; result: unknown }>();
  const json = (status: number, value: unknown) => ({
    status,
    headers: { "content-type": "application/json" },
    body: encoder.encode(JSON.stringify(value)),
  });
  const machine: SandboxMachine = {
    id: "ladder_box",
    async request(req) {
      const body = req.body === undefined
        ? ""
        : typeof req.body === "string" ? req.body : decoder.decode(req.body);
      if ((req.port ?? 8080) === BOX_CONTROL_PORT) {
        if (req.method === "POST" && req.path === "/agent/task") {
          log.prompts.push((JSON.parse(body) as { prompt?: string }).prompt ?? "");
          const taskId = `boxtask_${tasks.size}`;
          tasks.set(taskId, {
            status: "done",
            result: { ok: true, summary: "wrote the matcher", filesChanged: [], testsRun: 1, fns: ["matchInvoices"] },
          });
          return json(202, { taskId });
        }
        if (req.method === "GET" && req.path.startsWith("/agent/task/")) {
          const entry = tasks.get(req.path.slice("/agent/task/".length));
          return entry === undefined ? json(404, { error: "unknown task" }) : json(200, entry);
        }
        return json(200, { ok: true });
      }
      if (req.method === "GET" && req.path === "/vendo.json") return json(404, { error: "no manifest" });
      return json(200, { ok: true });
    },
    async url(port) {
      return `https://${port ?? 8080}-ladder.fake.test`;
    },
    files: {
      async read() { throw new Error("no file"); },
      async write() { /* nothing these tests read */ },
      async list() { return []; },
    },
    async snapshot() { return "fakebox:snap"; },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
  };
  return {
    async create() {
      log.created += 1;
      return machine;
    },
    async resume() { return machine; },
    async destroy() { /* released */ },
  };
}

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

async function harness(options: { sandbox?: boolean } = {}): Promise<{
  apps: ReturnType<typeof createApps>;
  box: BoxLog;
  /** Every prompt the model was asked, in order — the middleman detector. */
  prompts: string[];
}> {
  const root = await mkdtemp(join(tmpdir(), "vendo-ladder-e2e-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const store = createStore({ dataDir: join(root, ".data") });
  cleanups.push(async () => store.close());
  await store.ensureSchema();
  const guard = createGuard({ store, policy: "autopilot" });

  const hostDescriptors: ToolDescriptor[] = [{
    name: "host_list_unpaid_invoices",
    description: "List unpaid invoices",
    inputSchema: { type: "object", properties: {} },
    risk: "read",
  }];
  // The umbrella's composition dance: the registry the runtime executes through
  // gains the apps agent tools after createApps returns — exactly how server.ts
  // wires actions.add(apps.agentTools()).
  let appsTools: ToolRegistry | undefined;
  const boundTools = guard.bind({
    async descriptors() {
      return [...hostDescriptors, ...(appsTools === undefined ? [] : await appsTools.descriptors())];
    },
    async execute(call, callCtx) {
      if (call.tool === "host_list_unpaid_invoices") {
        return { status: "ok", output: { invoices: [], summary: "no unpaid invoices" } };
      }
      if (appsTools !== undefined) return appsTools.execute(call, callCtx);
      return { status: "error", error: { code: "not-found", message: `no tool ${call.tool}` } };
    },
  });

  const prompts: string[] = [];
  // Assembling a screen out of components cannot serve this ask, so the one door
  // out is taken — with a sentence, and nothing else.
  const model = scriptedModel((prompt) => {
    prompts.push(prompt);
    if (!prompt.includes(SCREEN_BRIEF_MARKER)) return { say: "" };
    if (prompt.includes(HANDED_OVER_MARKER)) return { say: "handed over" };
    return { tool: "escalate", input: { why: WHY } };
  });

  const box: BoxLog = { created: 0, prompts: [] };
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
        commitSource: (input) => appsRef!.commitSource(input, screenCtx),
        floor: appsRef!.floor(screenCtx),
      }),
      remember: async (appId, decisions, memoryCtx) => {
        await appsRef!.remember({ appId, decisions }, memoryCtx);
      },
    }),
    // The ONE gate both doors read. Absent, a sandbox does not merely go unused:
    // it does not exist.
    ...(options.sandbox === true ? { machine: { sandbox: fakeBox(box), boxEditPollMs: 5 } } : {}),
  });
  appsRef = apps;
  appsTools = apps.agentTools();
  await store.records("vendo_apps").put({
    id: APP_ID,
    data: { subject: principal.subject, enabled: false, doc: seedDoc },
    refs: { subject: principal.subject },
  });
  return { apps, box, prompts };
}

/** Every prompt that was NOT the assembly loop's — the middleman detector. A
 *  brain prompt here is a second engine deciding what to build. */
const nonScreenPrompts = (prompts: readonly string[]): string[] =>
  prompts.filter((prompt) => !prompt.includes(SCREEN_BRIEF_MARKER));

describe.sequential("the escalation ladder — one rung, and the gate both doors read", () => {
  it("an edit that escalates WITH a sandbox builds, on the person's own words plus one line", async () => {
    const { apps, box, prompts } = await harness({ sandbox: true });

    const result = await apps.edit(APP_ID, ASK, ctx);
    expect(result.failure).toBeUndefined();

    // THE MACHINE. A box was provisioned and the in-box agent was really asked
    // to build — not a promise that one happened.
    expect(box.created).toBeGreaterThan(0);
    expect(box.prompts).toHaveLength(1);

    // THE BRIEF, AND NOTHING BETWEEN. The person's words travel verbatim and the
    // escalation's one line rides beside them; there is no plan to anchor on and
    // nothing re-planned either of them.
    const brief = box.prompts[0]!;
    expect(brief).toContain(ASK);
    expect(brief).toContain(WHY);
    // THE MIDDLEMAN IS GONE: every model call in this edit was the assembly loop's.
    expect(nonScreenPrompts(prompts)).toHaveLength(0);

    // The app GRADUATED: the row now carries the machine that holds its code.
    expect(result.graduated).toBe(true);
    expect((await apps.get(APP_ID, ctx))?.machine).toBeDefined();
  }, 60_000);

  it("an edit that escalates with NO sandbox refuses, and the stored app is untouched", async () => {
    const { apps, box } = await harness();

    const result = await apps.edit(APP_ID, ASK, ctx);

    // Refused up front, and NOT retryable: a missing build machine is a blocker,
    // not a bad turn. The sentence names the gap in the person's own terms — no
    // flag name, no adapter name.
    expect(result.failure?.code).toBe("edit-rejected");
    expect(result.failure?.retryable).toBe(false);
    expect((result.issues ?? []).join(" ")).toContain("real build");
    expect((result.issues ?? []).join(" ")).not.toContain("sandbox");
    // No machine was provisioned to arrive at that answer.
    expect(box.created).toBe(0);
    // And the app the person already had is exactly as it was.
    const stored = await apps.get(APP_ID, ctx);
    expect(stored?.name).toBe("Invoice board");
    expect(stored?.machine).toBeUndefined();
    expect(JSON.stringify(stored?.tree)).toContain("Invoices");
  }, 60_000);

  it("a create that escalates stores a row with NO tree, and paints nothing until the box builds", async () => {
    const { apps, box } = await harness({ sandbox: true });
    const painted: VendoViewPart[] = [];

    const created = await apps.create({ prompt: ASK, onView: (part) => painted.push(part) }, ctx);

    // The ROW is what makes this a real app — it lists and it opens…
    expect((await apps.list(ctx)).map((app) => app.id)).toContain(created.id);
    // …but there is no screen on it: the box has not written anything to show,
    // and an instant skeleton would be a picture of an app that does not exist.
    expect(created.tree).toBeUndefined();
    expect(painted).toHaveLength(0);
    // The build still ran, on the same two things the edit door hands over.
    expect(box.created).toBeGreaterThan(0);
    expect(box.prompts[0]).toContain(ASK);
    expect(box.prompts[0]).toContain(WHY);
  }, 60_000);
});
