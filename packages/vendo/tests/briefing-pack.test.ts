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
 * a real `createVendo`, the real screen agent behind `vendo_make`, and — for the
 * box rung — the real consented build lane, from the person's yes on the standing
 * card to the brief the REAL box session door opens a message with. The scripted
 * model and the sandbox PROVIDER are the only two things faked, and neither of
 * them is a side of the seam under test — the producer (`compose-surfaces.ts`)
 * and both consumers are real.
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
  type AppId,
  type Principal,
  type RunContext,
} from "@vendoai/core";
import type { SandboxAdapter } from "@vendoai/apps";
import type { ComponentRegistry, VendoRouteMap, VendoTheme } from "@vendoai/apps/contract";
import { defineHarness } from "@vendoai/harnesses";
import { createSessionRoutes } from "@vendoai/harnesses/box-door";
import { disposeSessionMachines } from "@vendoai/harnesses/claude-code/box";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  // The box pool is module-scoped: without this, one case's box is the next
  // case's thread-reuse.
  await disposeSessionMachines();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_briefing" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "ses_briefing" };
const ASK = "match my invoices against payments";
const WHY = "this needs real matching code";

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

// ── the fake box ─────────────────────────────────────────────────────────────
// A stand-in PROVIDER whose `request()` is a transport over the ACTUAL box
// session door, so the brief this test reads is the brief a real box is opened
// with. Same shape as `build-lane.test.ts`'s, minus its in-box agent: nothing
// here reads the files a build leaves behind, only the words it was sent.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface BoxLog {
  /** Every brief the in-box builder was opened with — where its half of the
   *  briefing pack lands. */
  briefs: string[];
}

function fakeBox(log: BoxLog): SandboxAdapter {
  return {
    async create(spec: unknown) {
      const { env } = spec as { env: Record<string, string> };
      const disk = await mkdtemp(join(tmpdir(), "vendo-briefing-box-"));
      const root = join(disk, env["VENDO_WORKSPACE_ROOT"] ?? "");
      await mkdir(root, { recursive: true });
      cleanups.push(async () => { await rm(disk, { recursive: true, force: true }); });
      const routes = createSessionRoutes({
        root,
        // Unclaimed, so the host's first `/session/hello` claims it.
        token: "",
        env: {},
        openSession: (input: { emit: (event: Record<string, unknown>) => void }) => ({
          async send(prompt: string) {
            log.briefs.push(prompt);
            input.emit({ type: "text", delta: "done." });
          },
          async interrupt() { /* the turn stops; the session lives */ },
          async end() { /* the box is going away */ },
        }),
      }) as {
        handle: (method: string, pathname: string, headers: Record<string, string>, payload: unknown)
          => Promise<{ status: number; body: unknown }>;
      };
      return {
        id: "briefing_box",
        async request(req: { method: string; path: string; headers?: Record<string, string>; body?: Uint8Array | string }) {
          const payload = req.body === undefined
            ? {}
            : JSON.parse(typeof req.body === "string" ? req.body : decoder.decode(req.body)) as unknown;
          const answer = await routes.handle(req.method, req.path, req.headers ?? {}, payload);
          return { status: answer.status, headers: {}, body: encoder.encode(JSON.stringify(answer.body)) };
        },
        async destroy() { /* gone */ },
      };
    },
    async destroy() { /* released */ },
  } as unknown as SandboxAdapter;
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
  const model = {
    specificationVersion: "v2" as const,
    provider: "vendo-briefing",
    modelId: "vendo-briefing-v1",
    supportedUrls: {},
    async doGenerate(request: { prompt?: unknown }) {
      record(request);
      return { content: [{ type: "text" as const, text: "nothing here answers that" }], finishReason: "stop" as const, usage };
    },
    async doStream(request: { prompt?: unknown }) {
      record(request);
      const chunks: Array<Record<string, unknown>> = [
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

// ── one real walk: ask → screen agent, and a consented build → box ───────────

interface Walked {
  /** The screen agent's whole system prompt. */
  screenPrompt: string;
  /** The in-box builder's whole brief. */
  boxBrief: string;
}

/** The box pool is keyed by the app id, so two walks in one case must not share
 *  one — the second would be handed the first's warm box and never be briefed. */
let walks = 0;

async function tempStore(dir: string): Promise<VendoStore> {
  const store = createStore({ dataDir: dir });
  cleanups.push(async () => { await store.close(); });
  return store;
}

/** One composed deployment in a temp `.vendo` root, walked end to end.
 *  `brief` absent means the file is never written — the before/after of the gap
 *  this slice closes. */
async function walk(options: { brief?: string; routes?: VendoRouteMap } = {}): Promise<Walked> {
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
  const box: BoxLog = { briefs: [] };
  const vendo = createVendo({
    models: { default: model },
    principal: async () => principal,
    store: await tempStore(join(root, "store")),
    theme: THEME,
    catalog: CATALOG,
    ...(options.routes === undefined ? {} : { routes: options.routes }),
    sandbox: fakeBox(box),
    harness: defineHarness({
      name: "briefing-probe",
      async *run(turn) {
        await turn.tools.call(VENDO_MAKE_TOOL, { request: ASK });
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
  // The box rung, through the ONE door that reaches it: the standing card an
  // escalation raises, and the person's yes to it (`build-lane.test.ts`).
  const appId = `app_briefing_${walks += 1}` as AppId;
  const proposed = await vendo.apps.build.propose({ appId, name: "Invoice matcher", prompt: ASK, why: WHY }, ctx);
  if (!("approvalId" in proposed)) throw new Error(`expected a card, got ${JSON.stringify(proposed)}`);
  await vendo.guard.approvals.decide(proposed.approvalId, { approve: true }, principal);
  // The lane is DETACHED — the walk ends when the row does. This box builds
  // nothing, so the lane lands on "its own test did not pass"; what it was TOLD
  // is the only thing read here.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if ((await vendo.apps.get(appId, ctx))?.building === undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const screenPrompt = systemPrompts.find((prompt) => prompt.includes(SCREEN_MARKER));
  expect(screenPrompt, "the screen agent never ran").toBeDefined();
  expect(box.briefs, "the box rung never ran").toHaveLength(1);
  return { screenPrompt: screenPrompt ?? "", boxBrief: box.briefs[0] ?? "" };
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
    const fromBox = briefingSection(walked.boxBrief);

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

  it("carries the host's ROUTES to both rungs — the names only, never a path", async () => {
    const walked = await walk({
      routes: { accounts: { path: "/accounts", description: "Every account, with its balance." } },
    });

    const fromScreen = briefingSection(walked.screenPrompt);
    expect(fromScreen).toBe(briefingSection(walked.boxBrief));
    expect(fromScreen).toContain("ROUTES (this product's own pages");
    expect(fromScreen).toContain("- accounts: Every account, with its balance.");
    // THE security property. A writer picks a page by what it IS; the address is
    // the host's alone, spelled by its own router in `onNavigate`. A path in the
    // prompt is a URL for a model to copy, so no prompt on either rung carries one.
    expect(walked.screenPrompt).not.toContain("/accounts");
    expect(walked.boxBrief).not.toContain("/accounts");
  }, 60_000);

  it("says nothing about routes when the host registered none", async () => {
    expect(briefingSection((await walk()).screenPrompt)).not.toContain("ROUTES");
  }, 60_000);

  it("keeps the INSTRUCTIONS per-rung — the split did not collapse", async () => {
    const walked = await walk({ brief: BRIEF });

    // The screen agent reads the dialect manual and an environment note about a
    // loop with no disk. The box has a disk, a shell and a bundle to ship.
    expect(walked.screenPrompt).toContain("# Components (generated from the component schemas)");
    expect(walked.screenPrompt).toContain(SCREEN_MARKER);
    expect(walked.boxBrief).not.toContain("# Components (generated from the component schemas)");
    expect(walked.boxBrief).not.toContain(SCREEN_MARKER);

    // The build lane's own instructions, which only a rung with a disk can read.
    expect(walked.boxBrief).toContain("HOW IT SHIPS");
    expect(walked.screenPrompt).not.toContain("HOW IT SHIPS");

    // Belt and braces: whole prompts that were equal would mean one rung is
    // reading the other's job description.
    expect(walked.screenPrompt).not.toBe(walked.boxBrief);
  }, 60_000);

  it("carries `.vendo/brief.md` to the screen agent, and loses it when the file is gone", async () => {
    const withBrief = await walk({ brief: BRIEF });
    expect(withBrief.screenPrompt).toContain(BRIEF.trim());
    expect(withBrief.boxBrief).toContain(BRIEF.trim());

    // The same deployment with no `brief.md` on disk: the prompt loses exactly
    // that text and nothing else invents it.
    const withoutBrief = await walk();
    expect(withoutBrief.screenPrompt).not.toContain(BRIEF.trim());
    expect(withoutBrief.boxBrief).not.toContain(BRIEF.trim());
    // Still a pack, still identical — the brief is the only thing that moved.
    expect(briefingSection(withoutBrief.screenPrompt)).toBe(briefingSection(withoutBrief.boxBrief));
  }, 60_000);
});
