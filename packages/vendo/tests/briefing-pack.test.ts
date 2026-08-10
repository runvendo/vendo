/**
 * ONE briefing pack, two rungs, the same bytes.
 *
 * The spec's promise is that the product knowledge a writer gets does not depend
 * on WHICH writer answered: a screen the assembly loop wrote and an app the box
 * built are the same product to the person who asked. Before this, the two rungs
 * were told different things — the screen agent got the theme, the design rules
 * and the tool shape card and never saw `.vendo/brief.md` at all; the in-box
 * builder got none of them. Neither gap could be seen from the outside, which is
 * exactly why it survived.
 *
 * So this measures the two prompts THEMSELVES, on one real composed deployment:
 * a real `createVendo`, the real screen agent, a real escalation, and a box that
 * behaves like a box (a control port answering the `/agent/task` long-poll). The
 * scripted model and the sandbox PROVIDER are the only two things faked, and
 * neither of them is a side of the seam under test — the producer
 * (`compose-surfaces.ts`) and both consumers are real.
 *
 * Two assertions carry it, and they pull in opposite directions on purpose:
 *   - the briefing pack is byte-identical in both prompts (`toBe`), and
 *   - the INSTRUCTIONS around it are not, because the screen agent's dialect
 *     manual and the box's skin contract are different jobs. Prompts that were
 *     identical all the way through would mean the per-rung split collapsed.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_MAKE_TOOL,
  type Principal,
} from "@vendoai/core";
import type { SandboxAdapter, SandboxMachine } from "@vendoai/apps";
import type { ComponentRegistry, VendoTheme } from "@vendoai/apps/contract";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_briefing" };

// ── the host's `.vendo` configuration, with token values that appear nowhere
//    else, so no assertion below can be satisfied by shipped engine text ──────

const THEME: VendoTheme = {
  colors: {
    background: "#ffffff",
    surface: "#f7f7f5",
    text: "#101010",
    muted: "#6b6b6b",
    accent: "#0f7b4a",
    accentText: "#ffffff",
    danger: "#b3261e",
    border: "#e4e4e0",
  },
  typography: { fontFamily: "Onest", baseSize: "15px" },
  radius: { small: "6px", medium: "10px", large: "16px" },
  density: "compact",
  motion: "reduced",
};

const DESIGN_RULES = "Maple never shows a balance without its account name beside it.\n";
const BRIEF = "Maple is a bank for freelancers who invoice in three currencies.\n";

const CATALOG = {
  MapleBalanceCard: {
    component: null,
    description: "The account balance card.\nA second line the one-line reduction drops.",
  },
} as unknown as ComponentRegistry;

/** A host tool with a DECLARED response shape and a semantics annotation, so the
 *  pack's `hostSemantics` half is a real shape card rather than an empty one. */
const TOOLS_FILE = JSON.stringify({
  format: "vendo/tools@3",
  tools: [{
    name: "maple_spend_summary",
    description: "This month's spending",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { total: { type: "number" } }, required: ["total"] },
    risk: "read",
    binding: { kind: "route", method: "GET", path: "/spend", argsIn: "query" },
    semantics: { total: { kind: "money", unit: "cents" } },
  }],
});

/** The outline an escalating screen agent leaves behind. No `<Server kind>` line
 *  on purpose: the default rung IS the box, which is the rung measured here. */
const ESCALATED_PLAN = `<Plan name="Invoice matcher">
  <Group title="Matches">
    <Leaf component="Text" purpose="the matched invoices"/>
  </Group>
</Plan>`;

// ── the fake box ─────────────────────────────────────────────────────────────
// The control port 8811 and the `/agent/task` long-poll, and nothing more than
// this test reads: the TASK it was handed. Same shape as `box-wire.test.ts`'s —
// `@vendoai/apps`' box substrate is not on that package's exports map.

const BOX_CONTROL_PORT = 8811;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface BoxLog {
  /** The `context` of every task the in-box builder was handed — where its half
   *  of the briefing pack lands. */
  contexts: string[];
}

function fakeBox(log: BoxLog): SandboxAdapter {
  const tasks = new Map<string, { status: "done"; result: unknown }>();
  const json = (status: number, value: unknown) => ({
    status,
    headers: { "content-type": "application/json" },
    body: encoder.encode(JSON.stringify(value)),
  });
  const machine: SandboxMachine = {
    id: "briefing_box",
    async request(req) {
      const body = req.body === undefined
        ? ""
        : typeof req.body === "string" ? req.body : decoder.decode(req.body);
      if ((req.port ?? 8080) === BOX_CONTROL_PORT) {
        if (req.method === "POST" && req.path === "/agent/task") {
          const task = JSON.parse(body) as { context?: string };
          log.contexts.push(task.context ?? "");
          const taskId = `boxtask_${tasks.size}`;
          tasks.set(taskId, {
            status: "done",
            result: { ok: true, summary: "wrote the matcher", filesChanged: [], testsRun: 0, fns: [] },
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
      return `https://${port ?? 8080}-briefing.fake.test`;
    },
    files: {
      async read() { throw new Error("no file"); },
      async write() { /* the builder wrote nothing this test reads */ },
      async list() { return []; },
    },
    async snapshot() { return "fakebox:snap"; },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
  };
  return {
    async create() { return machine; },
    async resume() { return machine; },
    async destroy() { /* released */ },
  };
}

// ── the scripted model ───────────────────────────────────────────────────────

/** `environmentNote`'s own first line — the marker that says a prompt is the
 *  screen agent's, without counting model calls. */
const SCREEN_MARKER = "# In this loop";

interface Scripted {
  model: LanguageModel;
  /** Every SYSTEM prompt, raw — never JSON-stringified, because this test
   *  compares prompt bytes and an escaped newline is not the byte the model
   *  read. */
  systemPrompts: string[];
}

function scripted(): Scripted {
  const systemPrompts: string[] = [];
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const record = (request: { prompt?: unknown }): void => {
    const messages = (request.prompt ?? []) as Array<{ role: string; content: unknown }>;
    for (const message of messages) {
      if (message.role === "system" && typeof message.content === "string") {
        systemPrompts.push(message.content);
      }
    }
  };
  const escalating = (): boolean => systemPrompts.at(-1)?.includes(SCREEN_MARKER) === true;
  const escalateCall = {
    type: "tool-call" as const,
    toolCallId: "call_escalate",
    toolName: "escalate",
    input: JSON.stringify({ plan: ESCALATED_PLAN, why: "this needs real matching code" }),
  };
  const model = {
    specificationVersion: "v2" as const,
    provider: "vendo-briefing",
    modelId: "vendo-briefing-v1",
    supportedUrls: {},
    async doGenerate(request: { prompt?: unknown }) {
      record(request);
      return escalating()
        ? { content: [escalateCall], finishReason: "tool-calls" as const, usage }
        : { content: [{ type: "text" as const, text: "nothing here answers that" }], finishReason: "stop" as const, usage };
    },
    async doStream(request: { prompt?: unknown }) {
      record(request);
      const chunks: Array<Record<string, unknown>> = escalating()
        ? [escalateCall, { type: "finish", finishReason: "tool-calls", usage }]
        : [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "nothing here answers that" },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: "stop", usage },
        ];
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  };
  return { model: model as unknown as LanguageModel, systemPrompts };
}

// ── one real walk: ask → screen agent → escalate → box ───────────────────────

interface Walked {
  /** The screen agent's whole system prompt. */
  screenPrompt: string;
  /** The in-box builder's whole task context. */
  boxContext: string;
}

async function tempStore(dir: string): Promise<VendoStore> {
  const store = createStore({ dataDir: dir });
  cleanups.push(async () => { await store.close(); });
  return store;
}

/** One composed deployment in a temp `.vendo` root, walked end to end.
 *  `brief` absent means the file is never written — the before/after of the gap
 *  this slice closes. */
async function walk(options: { brief?: string } = {}): Promise<Walked> {
  vi.stubEnv("E2B_API_KEY", "");
  vi.stubEnv("VENDO_API_KEY", "");
  vi.stubEnv("VENDO_BASE_URL", "http://briefing.test");
  const root = await mkdtemp(join(tmpdir(), "vendo-briefing-"));
  await mkdir(join(root, ".vendo"), { recursive: true });
  await writeFile(join(root, ".vendo", "design-rules.md"), DESIGN_RULES);
  await writeFile(join(root, ".vendo", "tools.json"), TOOLS_FILE);
  if (options.brief !== undefined) await writeFile(join(root, ".vendo", "brief.md"), options.brief);
  const originalCwd = process.cwd();
  process.chdir(root);
  cleanups.push(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  const { model, systemPrompts } = scripted();
  const box: BoxLog = { contexts: [] };
  const vendo = createVendo({
    model,
    principal: async () => principal,
    store: await tempStore(join(root, "store")),
    theme: THEME,
    catalog: CATALOG,
    sandbox: fakeBox(box),
    harness: defineHarness({
      name: "briefing-probe",
      async *run(turn) {
        await turn.tools.call(VENDO_MAKE_TOOL, { request: "match my invoices against payments" });
        yield { type: "text", delta: "ok" };
      },
    }) as never,
  } as Parameters<typeof createVendo>[0]);

  const response = await vendo.handler(new Request("https://briefing.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thr_briefing",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "build me something" }] },
    }),
  }));
  expect(response.status).toBe(200);
  await response.text();

  const screenPrompt = systemPrompts.find((prompt) => prompt.includes(SCREEN_MARKER));
  expect(screenPrompt, "the screen agent never ran").toBeDefined();
  expect(box.contexts, "the box rung never ran").toHaveLength(1);
  return { screenPrompt: screenPrompt ?? "", boxContext: box.contexts[0] ?? "" };
}

/** Both rungs join their prompt SECTIONS with the same rule, so the pack is one
 *  section of each. Found by its own first line rather than by position — a pack
 *  that moved is still the same bytes, and a pack that changed is not. */
const briefingSection = (prompt: string): string => {
  const section = prompt.split("\n\n---\n\n").find((part) => part.startsWith("THEME TOKENS:"));
  expect(section, "no briefing pack in this prompt").toBeDefined();
  return section ?? "";
};

describe("the briefing pack reaches both rungs", () => {
  it("hands the screen agent and the box BYTE-IDENTICAL product knowledge", async () => {
    const walked = await walk({ brief: BRIEF });

    const fromScreen = briefingSection(walked.screenPrompt);
    const fromBox = briefingSection(walked.boxContext);

    // THE assertion. Not "both are defined", not "both mention the brief" — the
    // same string, or the two writers know different products.
    expect(fromScreen).toBe(fromBox);

    // And a pack that is identically EMPTY would pass the line above, so: every
    // half of it really arrived.
    expect(fromScreen).toContain("THEME TOKENS:");
    expect(fromScreen).toContain("#0f7b4a");
    expect(fromScreen).toContain("HOST DESIGN RULES:");
    expect(fromScreen).toContain(DESIGN_RULES.trim());
    expect(fromScreen).toContain(BRIEF.trim());
    // The catalog's existing one-line reduction (d5), applied: first line only.
    expect(fromScreen).toContain("- MapleBalanceCard: The account balance card.");
    expect(fromScreen).not.toContain("A second line the one-line reduction drops");
    // The semantics-annotated shape card, in this host's own units.
    expect(fromScreen).toContain("maple_spend_summary");
    expect(fromScreen).toContain(":money.cents");
  }, 60_000);

  it("keeps the INSTRUCTIONS per-rung — the split did not collapse", async () => {
    const walked = await walk({ brief: BRIEF });

    // The screen agent reads the dialect manual and an environment note about a
    // loop with no disk. The box has a disk, a shell and a skin contract.
    expect(walked.screenPrompt).toContain("COMPONENTS (generated from the component schemas");
    expect(walked.screenPrompt).toContain(SCREEN_MARKER);
    expect(walked.boxContext).not.toContain("COMPONENTS (generated from the component schemas");
    expect(walked.boxContext).not.toContain(SCREEN_MARKER);

    expect(walked.boxContext).toContain("SKIN CONTRACT (the box boundary you build against):");
    expect(walked.screenPrompt).not.toContain("SKIN CONTRACT (the box boundary you build against):");

    // Belt and braces: whole prompts that were equal would mean one rung is
    // reading the other's job description.
    expect(walked.screenPrompt).not.toBe(walked.boxContext);
  }, 60_000);

  it("carries `.vendo/brief.md` to the screen agent, and loses it when the file is gone", async () => {
    const withBrief = await walk({ brief: BRIEF });
    expect(withBrief.screenPrompt).toContain(BRIEF.trim());
    expect(withBrief.boxContext).toContain(BRIEF.trim());

    // The same deployment with no `brief.md` on disk: the prompt loses exactly
    // that text and nothing else invents it.
    const withoutBrief = await walk();
    expect(withoutBrief.screenPrompt).not.toContain(BRIEF.trim());
    expect(withoutBrief.boxContext).not.toContain(BRIEF.trim());
    // Still a pack, still identical — the brief is the only thing that moved.
    expect(briefingSection(withoutBrief.screenPrompt)).toBe(briefingSection(withoutBrief.boxContext));
  }, 60_000);
});
