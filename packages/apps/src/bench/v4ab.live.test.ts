/**
 * v4 create-prompt rewrite A/B (docs/verification/v4-prompt-ab) — offline leg.
 *
 * Measures the v4 create contract (pipeline.promptRewrite + endPass, ARM B)
 * against the current contract (ARM A, pipeline {}) on the REAL create path
 * with real per-host deps built from the demo hosts' .vendo files (catalog,
 * tools, semantics, theme, design-rules.md — design rules feed BOTH arms).
 *
 * NOT part of the gate and never runs under `pnpm test`: guarded by V4AB_MODE.
 *
 *   V4AB_MODE=create  — run 12 prompts x 2 arms x 2 attempts (resumable:
 *                       existing run files are skipped)
 *   V4AB_MODE=judge   — blind pairwise judging (App 1/App 2, both orderings;
 *                       win only when both orderings agree)
 *
 * Env: ANTHROPIC_API_KEY (canonical keys: /Users/yousefh/orca/workspaces/flowlet/.env).
 * Outputs: docs/verification/v4-prompt-ab/runs/*.json (committed as evidence).
 * Generator model: claude-sonnet-4-6 (both arms). Judge: claude-opus-4-8.
 * No paint lane (no onPartial); no extra thinking budget.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { LanguageModel } from "ai";
import { describe, it } from "vitest";
import { z } from "zod";
import {
  printWireV2,
  type DomainManifest,
  type NormalizedCatalog,
  type ToolSemantics,
  type VendoTheme,
} from "@vendoai/core";
import {
  modelEngine,
  type GenerationDependencies,
  type GenerationTimingEvent,
  type HostToolInfo,
} from "../engine.js";
import type { PipelineEvent } from "../pipeline.js";
import { pool } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const runsDir = resolve(repoRoot, "docs/verification/v4-prompt-ab/runs");

const GEN_MODEL = process.env.V4AB_GEN_MODEL ?? "claude-sonnet-4-6";
const JUDGE_MODEL = process.env.V4AB_JUDGE_MODEL ?? "claude-opus-4-8";

type Host = "demo-bank" | "demo-accounting";
type Arm = "A" | "B";

interface AbPrompt {
  id: string;
  host: Host;
  archetype: string;
  feasibility: "feasible" | "partial" | "impossible";
  prompt: string;
}

/** The 12 fresh dev prompts — authored blind 2026-07-20 (PROMPTS.md), burned
 *  to GOLDEN.md's DEV list by this run. */
const PROMPTS: AbPrompt[] = [
  { id: "AB-M1", host: "demo-bank", archetype: "dashboard", feasibility: "partial", prompt: "A money overview dashboard: my account balances, my spending by category this month, and how my stock portfolio has performed this quarter." },
  { id: "AB-M2", host: "demo-bank", archetype: "worklist+action", feasibility: "feasible", prompt: "List my upcoming scheduled payments with amounts and due dates, and let me pay the next one right now from my checking account." },
  { id: "AB-M3", host: "demo-bank", archetype: "detail", feasibility: "feasible", prompt: "A detail view for my checking account: the current balance, account number, and its recent transactions with each one's status." },
  { id: "AB-M4", host: "demo-bank", archetype: "form/flow", feasibility: "feasible", prompt: "A send-money flow: pick one of my saved payees, enter an amount and a note, review the details, then send it from checking." },
  { id: "AB-M5", host: "demo-bank", archetype: "board/timeline", feasibility: "feasible", prompt: "A timeline of money leaving my account soon: upcoming scheduled payments and subscription renewals, ordered by date with the total going out." },
  { id: "AB-M6", host: "demo-bank", archetype: "report", feasibility: "impossible", prompt: "An annual tax summary report: my capital gains, deductible expenses, and how much tax I'll owe this year." },
  { id: "AB-C1", host: "demo-accounting", archetype: "dashboard", feasibility: "partial", prompt: "A Monday-morning practice overview: how many clients are missing documents, documents outstanding versus received, the nearest filing deadlines, and the revenue we billed this month." },
  { id: "AB-C2", host: "demo-accounting", archetype: "worklist+action", feasibility: "feasible", prompt: "A chase list: clients with outstanding documents ranked worst-first, and let me send one of them a reminder message without leaving the page." },
  { id: "AB-C3", host: "demo-accounting", archetype: "detail", feasibility: "feasible", prompt: "A single client's page: their document checklist with per-document status, who on our staff is assigned, and the latest messages between us and them." },
  { id: "AB-C4", host: "demo-accounting", archetype: "form/flow", feasibility: "feasible", prompt: "A document review flow: pick a client, look through their uploaded documents, and verify or reject each one with a note to the client." },
  { id: "AB-C5", host: "demo-accounting", archetype: "board/timeline", feasibility: "feasible", prompt: "A deadlines board grouping clients by urgency — filing deadline this week, this month, and later — with each client's document progress on their card." },
  { id: "AB-C6", host: "demo-accounting", archetype: "report", feasibility: "impossible", prompt: "A billing report for the quarter: hours logged per client and the invoices we should be sending out." },
];

/** The two arms, selected per-create via GenerationDependencies.pipeline. */
const ARMS: Record<Arm, GenerationDependencies["pipeline"]> = {
  A: {},
  B: { promptRewrite: true, endPass: true },
};

// Auth/demo-control/voice endpoints are not app surface on either host; both
// arms see the identical filtered list, so this cannot bias the A/B.
const NON_APP_TOOLS = /^host_(auth|demo|voice|resetDemo|simulateClientUpload|createVoiceSession)/;

interface HostDeps {
  catalog: NormalizedCatalog;
  tools: HostToolInfo[];
  semantics: Record<string, ToolSemantics>;
  domains: DomainManifest;
  theme: VendoTheme;
  designRules: string;
}

const loadHost = (host: Host): HostDeps => {
  const dir = resolve(repoRoot, `apps/${host}/.vendo`);
  const read = (name: string): string => readFileSync(resolve(dir, name), "utf8");
  const catalogRaw = JSON.parse(read("catalog.json")) as {
    entries: Array<{ name: string; description: string; propsSchema: unknown; examples?: string[] }>;
  };
  const catalog = catalogRaw.entries.map((e) => ({
    name: e.name,
    description: e.description,
    component: null,
    props: z.object({}).passthrough(),
    propsJsonSchema: e.propsSchema,
    ...(e.examples === undefined ? {} : { examples: e.examples }),
  })) as unknown as NormalizedCatalog;
  const toolsRaw = JSON.parse(read("tools.json")) as {
    tools: Array<{ name: string; description: string; risk: string; inputSchema?: Record<string, unknown> }>;
  };
  const tools = toolsRaw.tools
    .filter(({ name }) => !NON_APP_TOOLS.test(name))
    .map(({ name, description, risk, inputSchema }) => ({
      name,
      description,
      risk,
      ...(inputSchema === undefined ? {} : { inputSchema }),
    }));
  const semanticsRaw = JSON.parse(read("semantics.json")) as {
    tools: Record<string, ToolSemantics>;
    domains: DomainManifest;
  };
  return {
    catalog,
    tools,
    semantics: semanticsRaw.tools,
    domains: semanticsRaw.domains,
    theme: JSON.parse(read("theme.json")) as VendoTheme,
    designRules: read("design-rules.md"),
  };
};

const anthropicModel = async (id: string): Promise<LanguageModel> => {
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("ANTHROPIC_API_KEY missing — source /Users/yousefh/orca/workspaces/flowlet/.env");
  }
  return createAnthropic({ apiKey })(id) as LanguageModel;
};

interface RunRecord {
  promptId: string;
  host: Host;
  arm: Arm;
  attempt: number;
  prompt: string;
  ok: boolean;
  error?: string;
  wallMs: number;
  fullAttempts: number;
  repairRounds: number;
  repairRepaired?: boolean;
  endPassApplied?: boolean;
  firstAttemptValid: boolean;
  inputTokens: number;
  outputTokens: number;
  nodes?: number;
  queries?: number;
  wire?: string;
  document?: unknown;
  timing: GenerationTimingEvent[];
  pipeline: PipelineEvent[];
}

const runFile = (promptId: string, arm: Arm, attempt: number): string =>
  resolve(runsDir, `${promptId}.${arm}.a${attempt}.json`);

const runOnce = async (p: AbPrompt, arm: Arm, attempt: number, model: LanguageModel, hosts: Record<Host, HostDeps>): Promise<RunRecord> => {
  const timing: GenerationTimingEvent[] = [];
  const pipeline: PipelineEvent[] = [];
  const h = hosts[p.host];
  const deps = {
    model,
    catalog: h.catalog,
    tools: h.tools,
    semantics: h.semantics,
    domains: h.domains,
    theme: h.theme,
    designRules: h.designRules,
    pipeline: ARMS[arm],
    onTiming: (event: GenerationTimingEvent) => timing.push(event),
    onPipeline: (event: PipelineEvent) => pipeline.push(event),
  } as unknown as GenerationDependencies;
  const start = Date.now();
  let record: RunRecord;
  const tokens = () => timing.reduce(
    (acc, e) => ({ in: acc.in + (e.usage?.inputTokens ?? 0), out: acc.out + (e.usage?.outputTokens ?? 0) }),
    { in: 0, out: 0 },
  );
  const fullAttempts = () => timing.filter((e) => e.lane === "full" && e.phase === "complete").length;
  const repairEvent = () => pipeline.find((e): e is Extract<PipelineEvent, { stage: "repair" }> => e.stage === "repair");
  const endPassEvent = () => pipeline.find((e): e is Extract<PipelineEvent, { stage: "end-pass" }> => e.stage === "end-pass");
  try {
    const document = await modelEngine.create({ prompt: p.prompt }, deps);
    const tree = document.tree as unknown as { nodes: unknown[]; queries?: unknown[] };
    const wire = printWireV2(
      { tree: document.tree, components: document.components ?? {}, name: document.name } as never,
      { includeIds: false },
    );
    const t = tokens();
    const repair = repairEvent();
    record = {
      promptId: p.id, host: p.host, arm, attempt, prompt: p.prompt,
      ok: true,
      wallMs: Date.now() - start,
      fullAttempts: fullAttempts(),
      repairRounds: repair?.rounds ?? 0,
      ...(repair === undefined ? {} : { repairRepaired: repair.repaired }),
      ...(endPassEvent() === undefined ? {} : { endPassApplied: endPassEvent()?.applied }),
      firstAttemptValid: fullAttempts() <= 1 && (repair?.rounds ?? 0) === 0,
      inputTokens: t.in, outputTokens: t.out,
      nodes: tree.nodes.length, queries: tree.queries?.length ?? 0,
      wire, document, timing, pipeline,
    };
  } catch (error) {
    const t = tokens();
    const repair = repairEvent();
    record = {
      promptId: p.id, host: p.host, arm, attempt, prompt: p.prompt,
      ok: false,
      error: error instanceof Error ? `${error.message} :: ${JSON.stringify((error as { details?: unknown }).details ?? [])} :: ${(process.env.V4AB_DEBUG === "1" ? error.stack ?? "" : "")}`.slice(0, 4000) : "unknown",
      wallMs: Date.now() - start,
      fullAttempts: fullAttempts(),
      repairRounds: repair?.rounds ?? 0,
      firstAttemptValid: false,
      inputTokens: t.in, outputTokens: t.out,
      timing, pipeline,
    };
  }
  writeFileSync(runFile(p.id, arm, attempt), `${JSON.stringify(record, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.log(`[v4ab:${p.id}:${arm}:a${attempt}] ok=${record.ok} first-valid=${record.firstAttemptValid} wall=${record.wallMs}ms fullAttempts=${record.fullAttempts} repairRounds=${record.repairRounds} outTok=${record.outputTokens}${record.ok ? "" : ` err=${record.error?.slice(0, 160)}`}`);
  return record;
};

// ---------------------------------------------------------------------------
// Pairwise judge — blind (App 1/App 2), both orderings, agreement required.
// ---------------------------------------------------------------------------

const judgeSystem = (host: Host, hosts: Record<Host, HostDeps>): string => {
  const h = hosts[host];
  const toolList = h.tools.map((t) => `${t.name} [${t.risk}] — ${t.description}`).join("\n");
  return `You are comparing two candidate generated apps ("App 1" and "App 2") built for the SAME user request against the SAME host product. Each app is expressed as "vendo wire" markup — a compact JSX-like tree of host/prewired components whose data comes ONLY from the host tools below via query bindings. Money fields are integer cents and dates are ISO strings unless a tool says otherwise; user-visible money/dates must be formatted (raw cents or raw ISO shown to the user is a defect). Charts take raw numbers.

HOST TOOLS:
${toolList}

HOST DOMAINS: has = ${h.domains.has.join(", ")}; has-NOT = ${h.domains.hasNot.join(", ")}.

Decide which app BETTER SERVES THE USER'S REQUEST, weighing:
- coverage of the ask (does it address what was asked, including the parts that are possible?)
- honesty (no invented data: every business value traces to a tool binding; labels/claims true of what is actually bound; when the host lacks the tool for part or all of the ask, an honest empty-state/disclaimer beats a fabricated section)
- composition and hierarchy quality (sensible layout, clear priority, not a component dump)
- formatting correctness (no raw cents, no raw ISO dates, no raw object/brace cells)
- action wiring (mutating asks carry a real mutating tool binding with a payload from real context; a submit button that does nothing is a defect)

Respond with ONLY a JSON object: {"winner": "app1" | "app2" | "tie", "reason": "<one or two sentences>"}`;
};

interface PairVerdict {
  promptId: string;
  ordering: "AB" | "BA";
  winnerArm: "A" | "B" | "tie" | "error";
  reason: string;
}

const judgePair = async (
  judgeModel: LanguageModel,
  system: string,
  prompt: string,
  first: { arm: Arm; wire: string },
  second: { arm: Arm; wire: string },
): Promise<{ winnerArm: "A" | "B" | "tie" | "error"; reason: string }> => {
  const { generateText } = await import("ai");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await generateText({
        model: judgeModel,
        system,
        prompt: `USER REQUEST:\n${prompt}\n\nAPP 1:\n${first.wire}\n\nAPP 2:\n${second.wire}`,
        maxOutputTokens: 500,
        maxRetries: 0,
      });
      const m = res.text.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]) as { winner?: string; reason?: string };
        const w = parsed.winner === "app1" ? first.arm : parsed.winner === "app2" ? second.arm : parsed.winner === "tie" ? "tie" : "error";
        return { winnerArm: w, reason: String(parsed.reason ?? "").slice(0, 400) };
      }
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!/429|overloaded|529|rate|timeout|fetch failed/i.test(msg) && attempt === 2) {
        return { winnerArm: "error", reason: msg.slice(0, 200) };
      }
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return { winnerArm: "error", reason: "unparseable/exhausted" };
};

/** Final document per arm for judging: attempt 1 unless it hard-failed. */
const finalRun = (promptId: string, arm: Arm): RunRecord | null => {
  for (const attempt of [1, 2]) {
    const f = runFile(promptId, arm, attempt);
    if (!existsSync(f)) continue;
    const r = JSON.parse(readFileSync(f, "utf8")) as RunRecord;
    if (r.ok && r.wire !== undefined) return r;
  }
  return null;
};

const mode = process.env.V4AB_MODE;
const TIMEOUT = 7_200_000;

describe.runIf(mode === "create")("v4ab create runs", () => {
  it("12 prompts x 2 arms x 2 attempts", { timeout: TIMEOUT }, async () => {
    mkdirSync(runsDir, { recursive: true });
    const model = await anthropicModel(GEN_MODEL);
    const hosts: Record<Host, HostDeps> = {
      "demo-bank": loadHost("demo-bank"),
      "demo-accounting": loadHost("demo-accounting"),
    };
    // V4AB_FILTER limits runs for smoke tests, e.g. "AB-M2:A:1" or "AB-C".
    const filter = process.env.V4AB_FILTER;
    const jobs: Array<{ p: AbPrompt; arm: Arm; attempt: number }> = [];
    for (const p of PROMPTS) for (const arm of ["A", "B"] as Arm[]) for (const attempt of [1, 2]) {
      if (filter !== undefined && !`${p.id}:${arm}:${attempt}`.startsWith(filter)) continue;
      if (!existsSync(runFile(p.id, arm, attempt))) jobs.push({ p, arm, attempt });
    }
    // eslint-disable-next-line no-console
    console.log(`[v4ab] ${jobs.length} runs to do (${48 - jobs.length} already on disk)`);
    await pool(jobs, 3, ({ p, arm, attempt }) => runOnce(p, arm, attempt, model, hosts));
  });
});

describe.runIf(mode === "judge")("v4ab pairwise judging", () => {
  it("both orderings per prompt, agreement required", { timeout: TIMEOUT }, async () => {
    const jm = await anthropicModel(JUDGE_MODEL);
    const hosts: Record<Host, HostDeps> = {
      "demo-bank": loadHost("demo-bank"),
      "demo-accounting": loadHost("demo-accounting"),
    };
    const verdicts: Array<{ promptId: string; verdict: "A" | "B" | "tie" | "skipped"; orderings: PairVerdict[] }> = [];
    await pool(PROMPTS, 3, async (p) => {
      const a = finalRun(p.id, "A");
      const b = finalRun(p.id, "B");
      if (a === null || b === null) {
        verdicts.push({ promptId: p.id, verdict: "skipped", orderings: [] });
        // eslint-disable-next-line no-console
        console.log(`[v4ab:judge:${p.id}] skipped (missing final doc: A=${a !== null} B=${b !== null})`);
        return;
      }
      const system = judgeSystem(p.host, hosts);
      const ab = await judgePair(jm, system, p.prompt, { arm: "A", wire: a.wire as string }, { arm: "B", wire: b.wire as string });
      const ba = await judgePair(jm, system, p.prompt, { arm: "B", wire: b.wire as string }, { arm: "A", wire: a.wire as string });
      const orderings: PairVerdict[] = [
        { promptId: p.id, ordering: "AB", winnerArm: ab.winnerArm, reason: ab.reason },
        { promptId: p.id, ordering: "BA", winnerArm: ba.winnerArm, reason: ba.reason },
      ];
      const verdict = ab.winnerArm === ba.winnerArm && (ab.winnerArm === "A" || ab.winnerArm === "B") ? ab.winnerArm : "tie";
      verdicts.push({ promptId: p.id, verdict, orderings });
      // eslint-disable-next-line no-console
      console.log(`[v4ab:judge:${p.id}] AB=${ab.winnerArm} BA=${ba.winnerArm} -> ${verdict}`);
    });
    verdicts.sort((x, y) => x.promptId.localeCompare(y.promptId));
    writeFileSync(resolve(runsDir, "judge-verdicts.json"), `${JSON.stringify(verdicts, null, 2)}\n`);
  });
});
