/**
 * THE SIX-TYPE MATRIX — the proof `experimentalScreenAgent`'s own comment asked
 * for before the flag could die ("OFF until the six-type proof matrix is
 * walked, because it changes which engine answers every screen ask").
 *
 * Six ask types, all through `vendo_make`, on a REAL composed deployment: real
 * store, real guard, real apps pack, real render seam, real checks floor, real
 * front door, real MCP door. Nothing on either side of any seam is stubbed
 * except the two things a test genuinely cannot have — the MODEL (scripted, so
 * ROUTING and not a provider's mood is what this measures) and the sandbox
 * PROVIDER, which is a fake box that behaves like a box: two listeners (the
 * app's $PORT and the harness control port), an in-box agent that actually
 * materializes files on the box's disk, a `vendo.json`, and snapshot/resume.
 *
 *  1. new simple screen        → assembled, row real, view painted
 *  2. edit of an existing one  → lands in place, repaints on the SAME stream id
 *  3. escalate WITH a sandbox  → the build runs, and the outline becomes the app
 *  4. escalate with NO sandbox → a failed receipt that says why, no orphan card
 *  5. assembler unavailable    → a failed receipt that says so, and nothing else runs
 *  6. the MCP door             → an outside agent gets words, and a screen lands
 *
 * There is ONE engine behind all six. The brain that used to sit between an
 * escalation and the box is gone, so case 3's proof is now the absence of a
 * middleman: the escalated plan reaches the in-box builder verbatim, the ask
 * travels beside it, and NOT ONE brain prompt is spent deciding what to build.
 * Case 2 is the same engine again — an edit is the screen agent opening the
 * app's own document and saving it back.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_MAKE_TOOL,
  makeReceiptSchema,
  type Principal,
  type ToolResult,
} from "@vendoai/core";
import type { SandboxAdapter, SandboxMachine } from "@vendoai/apps";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "./server.js";
import { bearer, composedHost, openDoor, runCleanups } from "./mcp-door.test-util.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await runCleanups();
});

const principal: Principal = { kind: "user", subject: "user_matrix" };

/** The smallest document the compiler renders and the seam paints. */
const SPENDING = `<App name="Spending">
  <Stack>
    <Text text="This month" />
  </Stack>
</App>`;

/** The plan an escalating screen agent writes: the outline the person watches. */
const ESCALATED_PLAN = `<Plan name="Invoice matcher">
  <Group title="Matches">
    <Leaf component="Text" purpose="the matched invoices"/>
  </Group>
</Plan>`;

/** The same app, after the edit ask — a screen edit is the whole document saved
 *  again, which is the only write path there is. */
const SPENDING_EDITED = `<App name="Spending">
  <Stack>
    <Text text="Last month" />
  </Stack>
</App>`;

// ── the fake box ─────────────────────────────────────────────────────────────
// Modelled on a real v2 box, not on what the host wishes one did: the control
// port 8811 answers /agent/env and the /agent/task long-poll, the app's $PORT
// answers /vendo.json and POST /fn/<name>, and the in-box agent WRITES FILES to
// the box's disk through the seam's own `files`. `@vendoai/apps`' `testing/`
// substrate is not on that package's exports map, so this is the local one —
// same shape as `box-wire.test.ts`'s.

/** The harness's control port, as `apps/src/box-agent.ts` fixes it. Spelled out
 *  rather than imported for the reason a real provider would: a sandbox adapter
 *  is on the other side of the seam and does not import our constants. */
const BOX_CONTROL_PORT = 8811;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface BoxState {
  env: Record<string, string>;
  files: Map<string, Uint8Array>;
  fns: Set<string>;
}

/** Everything the box actually did, for the assertions. */
interface BoxLog {
  created: number;
  tasks: string[];
  filesWritten: string[];
}

function fakeBox(log: BoxLog): SandboxAdapter {
  const state: BoxState = { env: {}, files: new Map(), fns: new Set() };
  const tasks = new Map<string, { status: "done"; result: unknown }>();
  const json = (status: number, value: unknown) => ({
    status,
    headers: { "content-type": "application/json" },
    body: encoder.encode(JSON.stringify(value)),
  });
  const machine: SandboxMachine = {
    id: "matrix_box",
    async request(req) {
      const port = req.port ?? 8080;
      const body = req.body === undefined
        ? ""
        : typeof req.body === "string" ? req.body : decoder.decode(req.body);
      if (port === BOX_CONTROL_PORT) {
        if (req.method === "POST" && req.path === "/agent/env") {
          state.env = { ...(JSON.parse(body) as { env: Record<string, string> }).env };
          return json(200, { ok: true });
        }
        if (req.method === "POST" && req.path === "/agent/task") {
          const { prompt } = JSON.parse(body) as { prompt: string };
          log.tasks.push(prompt);
          // The in-box agent, doing the one thing a fake must still really do:
          // put bytes on the box's disk. `filesChanged` is a claim; the disk is
          // the fact, and `commitSource` reads the disk.
          await machine.files.write("/app/fns.js", "export const matchInvoices = () => ({ matched: 12 });\n");
          state.fns.add("matchInvoices");
          const taskId = `boxtask_${tasks.size}`;
          tasks.set(taskId, {
            status: "done",
            result: { ok: true, summary: "wrote the invoice matcher", filesChanged: ["/app/fns.js"], testsRun: 1, fns: ["matchInvoices"] },
          });
          return json(202, { taskId });
        }
        if (req.method === "GET" && req.path.startsWith("/agent/task/")) {
          const entry = tasks.get(req.path.slice("/agent/task/".length));
          return entry === undefined ? json(404, { error: "unknown task" }) : json(200, entry);
        }
        return json(404, { error: `unknown control route: ${req.method} ${req.path}` });
      }
      if (req.method === "GET" && req.path === "/vendo.json") return json(404, { error: "no manifest" });
      const fn = /^\/fn\/([A-Za-z_][A-Za-z0-9_-]*)$/.exec(req.path);
      if (req.method === "POST" && fn?.[1] !== undefined) {
        return state.fns.has(fn[1])
          ? json(200, { result: { matched: 12 } })
          : json(404, { error: { code: "not-found", message: `no fn ${fn[1]}` } });
      }
      return json(200, { ok: true });
    },
    async url(port) {
      return `https://${port ?? 8080}-matrix_box.fake.test`;
    },
    files: {
      async read(path) {
        const bytes = state.files.get(path);
        if (bytes === undefined) throw new Error(`no such file in box: ${path}`);
        return bytes;
      },
      async write(path, bytes) {
        log.filesWritten.push(path);
        state.files.set(path, typeof bytes === "string" ? encoder.encode(bytes) : bytes);
      },
      async list(dir) {
        const prefix = dir.endsWith("/") ? dir : `${dir}/`;
        return [...state.files.keys()]
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length).split("/")[0] as string);
      },
    },
    async snapshot() {
      return "fakebox:snap";
    },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
  };
  return {
    async create() {
      log.created += 1;
      return machine;
    },
    async resume() {
      return machine;
    },
    async destroy() { /* released */ },
  };
}

// ── the scripted model ───────────────────────────────────────────────────────

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

type Chunk = Record<string, unknown>;

const call = (toolName: string, input: unknown, toolCallId: string): Chunk[] => [
  { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
];

const speak = (text: string): Chunk[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
];

/** The screen agent's own brief, verbatim from `environmentNote`. The one marker
 *  that says "this prompt is the assembly loop's" without counting calls. */
const SCREEN_BRIEF_MARKER = "# In this loop";
/** The brain's own marker. It is asserted ABSENT: the brain is deleted, and a
 *  prompt carrying this again would mean a second engine came back. */
const BRAIN_MARKER = "THEY ARE ASKING NOW:";

interface ScriptOptions {
  /** The screen agent's steps, in order, across every run in the walk. A create
   *  and an edit are the SAME loop, so one FIFO feeds both. Exhausted → it stops
   *  talking. */
  screenTurns: Chunk[][];
}

interface ScriptedModel {
  model: LanguageModel;
  /** Every prompt the model was handed, in order. */
  prompts: string[];
}

function scripted(options: ScriptOptions): ScriptedModel {
  const prompts: string[] = [];
  const screen = options.screenTurns.map((turn) => [...turn]);
  const stream = (chunks: Chunk[]): { stream: ReadableStream } => ({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  });
  const answer = (prompt: string): Chunk[] => {
    if (prompt.includes(SCREEN_BRIEF_MARKER)) {
      return screen.shift() ?? speak("nothing more to do");
    }
    // Anything else is a model call this matrix does not expect. Answering it
    // with a document would hide a second engine; a bare sentence cannot.
    return speak("nothing here answers that");
  };
  const textOf = (call_: { prompt?: unknown }): string => JSON.stringify(call_.prompt ?? "");
  const model = {
    specificationVersion: "v2",
    provider: "vendo-matrix",
    modelId: "vendo-matrix-v1",
    supportedUrls: {},
    async doGenerate(request: { prompt?: unknown }) {
      const prompt = textOf(request);
      prompts.push(prompt);
      const chunks = answer(prompt);
      const toolCall = chunks.find((chunk) => chunk["type"] === "tool-call");
      if (toolCall !== undefined) {
        return {
          content: [{
            type: "tool-call" as const,
            toolCallId: toolCall["toolCallId"] as string,
            toolName: toolCall["toolName"] as string,
            input: toolCall["input"] as string,
          }],
          finishReason: "tool-calls" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: chunks.filter((chunk) => chunk["type"] === "text-delta").map((chunk) => chunk["delta"] as string).join(""),
        }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream(request: { prompt?: unknown }) {
      const prompt = textOf(request);
      prompts.push(prompt);
      return stream(answer(prompt));
    },
  };
  return { model: model as unknown as LanguageModel, prompts };
}

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-matrix-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

interface View {
  appId: string;
  /** The ai-SDK reconciliation id — `vendo-view:<appId>`, the STREAM. */
  id?: string;
  payload: Record<string, unknown>;
}

interface Walked {
  receipts: ReturnType<typeof makeReceiptSchema.parse>[];
  results: ToolResult[];
  views: View[];
  vendo: ReturnType<typeof createVendo>;
  prompts: string[];
  box: BoxLog;
}

/** Every prompt that was NOT the assembly loop's — the middleman detector. A
 *  brain prompt here is a second engine reappearing. */
const nonScreenPrompts = (prompts: readonly string[]): string[] =>
  prompts.filter((prompt) => !prompt.includes(SCREEN_BRIEF_MARKER));

/**
 * One real turn whose harness does exactly what a calling agent does: ask
 * `vendo_make` in words, and hand back the receipt. `asks` is that agent's
 * script — one entry per `vendo_make` call, in order.
 */
async function walk(options: ScriptOptions & {
  asks: Array<{ request: string; app?: (previous: Walked["receipts"]) => string }>;
  /** Configure a sandbox — the ONE gate on machine-backed execution. */
  sandbox?: boolean;
  /** Open the app after the last ask, which is the shipped repaint rail for an
   *  edit (an edit's receipt is words; `vendo_apps_open`'s is a tree). */
  openAfter?: boolean;
}): Promise<Walked> {
  vi.stubEnv("VENDO_BASE_URL", "http://matrix.test");
  vi.stubEnv("VENDO_BOX_EDIT_POLL_MS", "5");
  const store = await tempStore();
  const { model, prompts } = scripted(options);
  const box: BoxLog = { created: 0, tasks: [], filesWritten: [] };
  const receipts: Walked["receipts"] = [];
  const results: ToolResult[] = [];
  const harness = defineHarness({
    name: "matrix-probe",
    async *run(turn) {
      for (const ask of options.asks) {
        const result = await turn.tools.call(VENDO_MAKE_TOOL, {
          request: ask.request,
          ...(ask.app === undefined ? {} : { app: ask.app(receipts) }),
        });
        results.push(result);
        if (result.status === "ok") receipts.push(makeReceiptSchema.parse(result.output));
      }
      if (options.openAfter === true && receipts.length > 0) {
        await turn.tools.call("vendo_apps_open", { appId: receipts.at(-1)!.id });
      }
      yield { type: "text", delta: "ok" };
    },
  });
  const vendo = createVendo({
    model,
    principal: async () => principal,
    store,
    harness: harness as never,
    ...(options.sandbox === true ? { sandbox: fakeBox(box) } : {}),
  } as Parameters<typeof createVendo>[0]);
  const response = await vendo.handler(new Request("https://matrix.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thr_matrix",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "make me something" }] },
    }),
  }));
  const raw = await response.text();
  expect(response.status).toBe(200);
  const views = raw
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map((block) => JSON.parse(block.slice("data: ".length)) as Record<string, unknown>)
    .filter((chunk) => chunk["type"] === "data-vendo-view")
    .map((chunk) => ({
      ...(chunk["data"] as { appId: string; payload: Record<string, unknown> }),
      ...(typeof chunk["id"] === "string" ? { id: chunk["id"] } : {}),
    }));
  return { receipts, results, views, vendo, prompts, box };
}

const ctx = { principal, venue: "chat" as const, presence: "present" as const };

describe("the six-type matrix — every `vendo_make` ask type, one deployment", () => {
  it("TYPE 1 · a new simple screen is assembled, the row is real, the view is painted", async () => {
    const walked = await walk({
      asks: [{ request: "show me what I spent this month" }],
      screenTurns: [
        call("save_app", { content: SPENDING }, "c1"),
        call("validate", { document: SPENDING }, "c2"),
        speak("done"),
      ],
    });

    const receipt = walked.receipts[0]!;
    expect(receipt.status).toBe("ready");
    expect(receipt.title).toBe("Spending");
    // Words only — never the screen itself (§3.1).
    expect(JSON.stringify(receipt)).not.toContain("<App");

    // The ROW: `authored` is what makes a written file an app.
    const stored = await walked.vendo.apps.get(receipt.id, ctx);
    expect(stored?.name).toBe("Spending");
    expect((await walked.vendo.apps.list(ctx)).map((app) => app.id)).toContain(receipt.id);

    // The VIEW, on this app's own stream, settled.
    expect(walked.views.length).toBeGreaterThan(0);
    expect(new Set(walked.views.map((view) => view.appId))).toEqual(new Set([receipt.id]));
    expect(walked.views.at(-1)?.payload["streaming"]).toBe(false);
  }, 60_000);

  it("TYPE 2 · an edit of an existing screen lands in place and repaints on the SAME stream id", async () => {
    const walked = await walk({
      asks: [
        { request: "show me what I spent this month" },
        { request: "say last month instead", app: (previous) => previous[0]!.id },
      ],
      // BOTH asks reach the screen agent: an edit is the same loop, asked to
      // open this app's document and save it back. There is no second dialect.
      screenTurns: [
        call("save_app", { content: SPENDING }, "c1"),
        speak("saved"),
        call("save_app", { content: SPENDING_EDITED }, "c2"),
        speak("edited"),
      ],
      openAfter: true,
    });

    const [created, edited] = walked.receipts;
    expect(created?.status).toBe("ready");
    expect(edited?.status).toBe("ready");
    // IN PLACE: one app, not two.
    expect(edited?.id).toBe(created?.id);
    expect(JSON.stringify(await walked.vendo.apps.get(created!.id, ctx))).toContain("Last month");

    // SAME STREAM: every view of this whole turn — the assembly paint and the
    // post-edit repaint — carries one appId, so the ai-SDK reconciliation id is
    // one id and the card updates rather than a second card appearing beside it.
    expect(new Set(walked.views.map((view) => view.appId))).toEqual(new Set([created!.id]));
    expect(new Set(walked.views.map((view) => view.id).filter((id) => id !== undefined)))
      .toEqual(new Set([`vendo-view:${created!.id}`]));
    // The repaint is a real second paint, not the first one counted twice.
    expect(walked.views.length).toBeGreaterThan(1);
    // ONE ENGINE: no brain answered either half of this.
    expect(nonScreenPrompts(walked.prompts)).toHaveLength(0);
  }, 60_000);

  it("TYPE 3 · an escalation WITH a sandbox builds, and the outline becomes the app", async () => {
    const walked = await walk({
      sandbox: true,
      asks: [{ request: "match my invoices against payments and show me what didn't clear" }],
      screenTurns: [call("escalate", { plan: ESCALATED_PLAN, why: "this needs real matching code" }, "c1")],
    });

    const receipt = walked.receipts[0]!;
    // Not a failure and not a fall-through apology: the build ran.
    expect(receipt.status).toBe("ready");

    // THE PLAN IS THE BRIEF, AND NOTHING SITS BETWEEN THEM. The person is
    // already looking at this outline, so a build that re-planned from the ask
    // alone would swap the thing they are watching for a different app under the
    // same card. The plan reaches the in-box builder as its task, the ask travels
    // verbatim beside it, and the plan's own `<Server>` — absent here, so the
    // escalation itself says "box" — is what chose this lane.
    const task = walked.box.tasks.join("\n");
    expect(task).toContain("Invoice matcher");
    expect(task).toContain("match my invoices against payments");
    // THE MIDDLEMAN IS GONE. Not one prompt outside the assembly loop, so no
    // brain re-planned this and no fill worker wrote into it.
    expect(nonScreenPrompts(walked.prompts)).toHaveLength(0);
    expect(walked.prompts.filter((prompt) => prompt.includes(BRAIN_MARKER))).toHaveLength(0);

    // THE MACHINE. A box was provisioned and the in-box agent really wrote to
    // its disk — the fake is a box, not a promise that one happened.
    expect(walked.box.created).toBeGreaterThan(0);
    expect(walked.box.tasks.length).toBeGreaterThan(0);
    expect(walked.box.filesWritten).toContain("/app/fns.js");

    // THE ROW, with the machine on it: this is a graduated app, not a picture.
    const stored = await walked.vendo.apps.get(receipt.id, ctx);
    expect(stored).not.toBeNull();
    expect(stored?.machine).toBeDefined();

    // ONE STREAM. The plan's skeleton and the finished app paint on the same id,
    // so the outline the person watched became the app in place. The skeleton is
    // the FIRST paint and it is streaming; the app is the LAST and it is not.
    expect(new Set(walked.views.map((view) => view.appId))).toEqual(new Set([receipt.id]));
    expect(walked.views[0]?.payload["streaming"]).toBe(true);
    // SETTLED. `streaming` is what `chrome/thread/parts.tsx` keys its
    // dead-card unmount on, so "not true" is exactly the state that means the
    // card holds an answer rather than a shimmer.
    expect(walked.views.at(-1)?.payload["streaming"]).not.toBe(true);
    expect(walked.views.length).toBeGreaterThan(1);
  }, 120_000);

  it("TYPE 4 · an escalation with NO sandbox fails honestly, and leaves no card building forever", async () => {
    const walked = await walk({
      asks: [{ request: "match my invoices against payments and show me what didn't clear" }],
      screenTurns: [call("escalate", { plan: ESCALATED_PLAN, why: "this needs real matching code" }, "c1")],
    });

    const receipt = walked.receipts[0]!;
    expect(receipt.status).toBe("failed");
    // The say names the capability gap in the person's terms — no flag name, no
    // adapter name, nothing for the model to relay that a person cannot act on.
    expect(receipt.say).toContain("real build");
    expect(receipt.say).not.toContain("sandbox");
    // And it names the card the person is looking at, not a label: the title is
    // the plan's own name, which is also the title on the painted skeleton. That
    // is only possible because the plan was read back on THIS path too.
    expect(receipt.title).toBe("Invoice matcher");

    // NOTHING RAN BEHIND IT. There is no second engine to spend a whole build's
    // latency arriving at a worse version of the screen the person already saw.
    expect(nonScreenPrompts(walked.prompts)).toHaveLength(0);
    expect(JSON.stringify(walked.views)).not.toContain("This month");

    // NO ORPHAN. The plan's skeleton is the only paint, it is on this app's own
    // stream, and it is the last word there — so `chrome/thread/parts.tsx`'s
    // rule ("a still-forming view on a turn that is over is unmounted") has
    // exactly the shape it keys on. The receipt, not a shimmer, is the answer.
    expect(new Set(walked.views.map((view) => view.appId))).toEqual(new Set([receipt.id]));
    expect(walked.views.every((view) => view.payload["streaming"] === true)).toBe(true);
    // And the turn is OVER: the walk only returns once the response body is
    // fully drained, which is what makes the card dead rather than pending.
  }, 60_000);

  it("TYPE 5 · an assembler that produces nothing renderable fails honestly — nothing rescues it", async () => {
    // The control case, inverted. The screen agent saved bytes the compiler cannot
    // render, so the seam painted nothing and `authored` stored no row. There is
    // no engine left to fall through to, and an unwired or unserving assembler is
    // a composition bug that has to surface rather than be quietly served.
    const walked = await walk({
      asks: [{ request: "show me what I spent this month" }],
      screenTurns: [call("save_app", { content: "not a document at all" }, "c1"), speak("saved")],
    });

    const receipt = walked.receipts[0]!;
    expect(receipt.status).toBe("failed");
    // The say is plain, and it is about this ask.
    expect(receipt.say).toContain("couldn't put that screen together");
    expect(receipt.title).toBe("show me what I spent this month");
    // NOTHING generated behind it: not one prompt outside the loop, no row, no paint.
    expect(nonScreenPrompts(walked.prompts)).toHaveLength(0);
    expect(await walked.vendo.apps.get(receipt.id, ctx)).toBeNull();
    expect(JSON.stringify(walked.views)).not.toContain("This month");
  }, 60_000);

  it("TYPE 6 · the MCP door: an outside agent asks for a screen, gets words, and a screen lands", async () => {
    // No stream to paint on — an outside agent has no surface — so "the screen
    // was made" can only be read where it really lives: the store, through the
    // real read path. The words are the receipt, in-band, exactly as the
    // one-tool contract promises.
    const { model } = scripted({
      screenTurns: [
        call("save_app", { content: SPENDING }, "c1"),
        call("validate", { document: SPENDING }, "c2"),
        speak("done"),
      ],
    });
    const host = await composedHost(async () => undefined, model);
    const door = await openDoor(host.vendo, await bearer(host.vendo));

    const answered = await door.callTool(VENDO_MAKE_TOOL, { request: "show me what I spent this month" });

    expect(answered.isError).toBeFalsy();
    // Words back: the four-field receipt, and nothing that could be a document.
    const receipt = makeReceiptSchema.parse(JSON.parse(answered.text) as unknown);
    expect(receipt.status).toBe("ready");
    expect(receipt.title).toBe("Spending");
    expect(answered.text).not.toContain("<App");

    // Screen painted — where an outside agent's screen can be: on the row, read
    // back through the runtime's own door.
    const outsideCtx = { principal: { kind: "user" as const, subject: "user_parity" }, venue: "mcp" as const, presence: "present" as const };
    const stored = await host.vendo.apps.get(receipt.id, outsideCtx);
    expect(stored?.name).toBe("Spending");
    const opened = await host.vendo.apps.open(receipt.id, outsideCtx);
    expect(JSON.stringify(opened)).toContain("This month");
  }, 60_000);
});
