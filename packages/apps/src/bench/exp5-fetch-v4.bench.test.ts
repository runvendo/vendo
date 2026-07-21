/**
 * W1-bench Experiment 5 — fetch-then-generate REVISIT under the v4 create
 * contract (pipeline.promptRewrite; spec 2026-07-20-vendo-v4-generation-wave).
 *
 * Exp3 (old contract) DEFERRED fetch-then-generate: binding errors dropped to
 * 0.00 but compile-ok regressed (81% vs 100%), concentrated in negatives that
 * drifted to prose refusals. This re-runs the SAME comparison with BOTH arms
 * on the v4 contract, single-shot (no structured repair, endPass off) so the
 * lever is isolated:
 *   Arm A (blind)  — today's path: v4 contract, shape cards only.
 *   Arm B (fetch)  — phase-1 no-think read-planner picks read tools; the
 *                    runtime "executes" them (fixture samples, arrays trimmed
 *                    to 2 rows + true rowCount) and the generation prompt
 *                    carries the real data digest.
 *
 * 10 FRESH dev prompts (burned to docs/eval/GOLDEN.md DEV list), 2 attempts
 * per prompt per arm. Deps-level composition only — no engine changes: the
 * system prompt is the engine's own wireContractV4(deps), the digest rides
 * the user turn.
 *
 * Metrics: compile-ok, binding-shape errors (production compiler verdicts),
 * LABEL-TRUTH errors (opus judge against the ground-truth tool data, blind to
 * arm), honest latency (arm B counts the serialized phase-1 call), tokens.
 *
 * Run: (env-loaded) pnpm --filter @vendoai/apps exec vitest run src/bench/exp5-fetch-v4.bench.test.ts
 */
import { describe, expect, it } from "vitest";
import { generateText } from "ai";
import {
  compileWireV2,
  describeShape,
  WIRE_COMPONENT_NAMES,
  type Json,
  type NormalizedCatalog,
  type VendoTheme,
} from "@vendoai/core";
import { wireContractV4, type GenerationDependencies, type HostToolInfo } from "../engine.js";
import { genModel, generateWire, judgeModel, pool } from "./client.js";
import { MAPLE_TOOLS, MAPLE_TOOL_SHAPES, THEME } from "./fixtures.js";
import { writeRaw } from "./report.js";

// ---------------------------------------------------------------------------
// Prompts — authored FRESH for this revisit (never used in exp1-3, never in
// the golden set). On commit they are burned to the GOLDEN.md DEV list.
// Positives deliberately bait the dominant final-gate fail class: headline /
// superlative / period claims the model must make about data it may not have
// seen. The two negatives reproduce exp3's compile-regression trigger (no
// tool for the ask -> empty fetch).
// ---------------------------------------------------------------------------

export const EXP5_POSITIVE_PROMPTS: string[] = [
  "A headline card saying exactly how much money we're owed right now, with the overdue invoices behind the number.",
  "Which client owes us the most? Show them prominently with their invoices and a way to nudge them.",
  "A cash position dashboard: our total cash and each account's balance with its trend.",
  "Show this quarter's spending by category as a donut, and call out the biggest category by name.",
  "A revenue check-in: are we growing? Show the latest month's revenue with the trend behind it.",
  "An invoice detail page for our most overdue invoice, with its line items and a mark-paid button.",
  "A collections workspace: every overdue invoice with a reminder button per row and a total at the top.",
  "A Monday-morning finance digest: cash on hand, overdue total, spending hotspots, and what to chase first.",
];

export const EXP5_NEGATIVE_PROMPTS: string[] = [
  "Show our payroll costs per employee for this month.",
  "A dashboard of our stock portfolio performance with today's gains.",
];

const PROMPTS = [...EXP5_POSITIVE_PROMPTS, ...EXP5_NEGATIVE_PROMPTS];
const ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Deps — the engine's own v4 create contract, built from the Maple fixture
// host. Host catalog is empty so the Kit is the component surface (the v4
// prompt teaches the Kit; the fixture "catalog" of exp1-3 is a Kit subset).
// Input sketches are provided so HOST TOOLS reads like production. Both arms
// share every byte of this.
// ---------------------------------------------------------------------------

const INPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  "invoices.list": { type: "object", properties: { status: { type: "string", enum: ["draft", "sent", "overdue", "paid"] } } },
  "invoices.get": { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  "invoices.sendReminders": { type: "object", properties: { invoiceIds: { type: "array", items: { type: "string" } } }, required: ["invoiceIds"] },
  "invoices.markPaid": { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  "clients.list": { type: "object", properties: {} },
  "clients.search": { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  "accounts.list": { type: "object", properties: {} },
  "accounts.transactions": { type: "object", properties: { accountId: { type: "string" } } },
  "payments.create": { type: "object", properties: { accountId: { type: "string" }, amountCents: { type: "number" }, toClientId: { type: "string" } }, required: ["accountId", "amountCents", "toClientId"] },
  "spending.byCategory": { type: "object", properties: { period: { type: "string", enum: ["month", "quarter", "year"] } } },
  "revenue.monthly": { type: "object", properties: {} },
};

const TOOL_INFO: HostToolInfo[] = MAPLE_TOOLS.map(({ name, description, risk }) => ({
  name,
  description,
  risk,
  ...(INPUT_SCHEMAS[name] === undefined ? {} : { inputSchema: INPUT_SCHEMAS[name] }),
}));

const V4_THEME: VendoTheme = {
  colors: {
    background: THEME.colors.background,
    surface: THEME.colors.surface,
    text: THEME.colors.text,
    muted: "#6B6B6B",
    accent: THEME.colors.accent,
    accentText: "#FFFFFF",
    danger: THEME.colors.danger,
    border: THEME.colors.border,
  },
  typography: { fontFamily: THEME.fontFamily, baseSize: "14px" },
  radius: { small: "4px", medium: "8px", large: "12px" },
  density: "comfortable",
  motion: "full",
};

const DEPS: GenerationDependencies = {
  model: undefined as never, // resolved lazily in the test body (needs the key)
  catalog: [] as NormalizedCatalog,
  theme: V4_THEME,
  tools: TOOL_INFO,
  toolShapes: MAPLE_TOOL_SHAPES,
  pipeline: { promptRewrite: true, endPass: false },
};

// ---------------------------------------------------------------------------
// Metrics — same philosophy as metrics.ts (the production compiler's own
// verdicts), recomputed here because the v4 surface compiles with the
// PRODUCTION options (inlineRefs + inlineTools + toolShapes) and its component
// vocabulary is WIRE_COMPONENT_NAMES (Kit + prewired), not the exp1-3 fixture
// catalog.
// ---------------------------------------------------------------------------

const KNOWN_TOOLS = new Set(MAPLE_TOOLS.map((t) => t.name));

const HARD_STRUCTURAL = new Set([
  "missing-app", "nested-app", "truncated-tag", "eof-unclosed", "unclosed-element",
  "unclosed-skipped", "compile-failed", "node-limit", "query-limit", "component-limit",
  "invalid-query-tool", "invalid-query-name", "unknown-element",
]);

export interface V4Metrics {
  compileOk: boolean;
  refErrors: number;
  bindingShapeErrors: number;
  unknownTool: number;
  unknownRef: number;
  unknownComponent: number;
  invalidAction: number;
  queryCount: number;
  nodeCount: number;
  islandCount: number;
  usedDisclaimer: boolean;
  empty: boolean;
}

export const computeV4Metrics = (wire: string): V4Metrics => {
  const r = compileWireV2(wire, {
    hostComponents: [],
    inlineRefs: true,
    inlineTools: [...KNOWN_TOOLS],
    toolShapes: MAPLE_TOOL_SHAPES,
  });
  const nodes = r.tree.nodes ?? [];
  const queries = r.tree.queries ?? [];
  const islandNames = new Set(Object.keys(r.components ?? {}));
  const allowed = new Set<string>([...WIRE_COMPONENT_NAMES, ...islandNames]);

  const issueCounts = new Map<string, number>();
  for (const iss of r.issues) issueCounts.set(iss.code, (issueCounts.get(iss.code) ?? 0) + 1);

  let unknownTool = 0;
  for (const q of queries) {
    if (!q.tool.startsWith("fn:") && !KNOWN_TOOLS.has(q.tool)) unknownTool++;
  }
  let unknownComponent = 0;
  for (const n of nodes) {
    if (n.id === "root") continue;
    if (!allowed.has(n.component)) unknownComponent++;
  }
  const invalidAction = issueCounts.get("invalid-action") ?? 0;
  const unknownRef = issueCounts.get("unknown-reference") ?? 0;
  const bindingShapeErrors = r.bindingErrors.length;
  const hasHard = [...issueCounts.keys()].some((c) => HARD_STRUCTURAL.has(c));
  const empty = nodes.length <= 1;
  return {
    compileOk: r.complete && !hasHard && !empty,
    refErrors: bindingShapeErrors + unknownTool + unknownRef + unknownComponent + invalidAction,
    bindingShapeErrors,
    unknownTool,
    unknownRef,
    unknownComponent,
    invalidAction,
    queryCount: queries.length,
    nodeCount: nodes.length,
    islandCount: islandNames.size,
    usedDisclaimer: nodes.some((n) => n.component === "Disclaimer"),
    empty,
  };
};

// ---------------------------------------------------------------------------
// Phase 1 — the read planner (exp3's design, with usage + latency captured so
// arm B's serialization cost is measured honestly).
// ---------------------------------------------------------------------------

const READ_TOOLS = MAPLE_TOOLS.filter((t) => t.risk === "read");

const PHASE1_SYSTEM = `You are the read-planner. Given a user request and the available READ tools, output ONLY a JSON array of the reads needed, each {"tool":"<name>","input":{...}}. Use only these tools; if NONE provides the data the request needs, output []. No prose.
READ TOOLS:
${READ_TOOLS.map((t) => `- ${t.name}: ${t.description}`).join("\n")}`;

interface PlannerResult {
  reads: { tool: string; input?: Record<string, unknown> }[];
  ms: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

const planReads = async (prompt: string): Promise<PlannerResult> => {
  const started = Date.now();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await generateText({
        model: genModel(),
        system: PHASE1_SYSTEM,
        prompt: `USER_REQUEST: ${prompt}`,
        maxOutputTokens: 800,
        maxRetries: 0,
      });
      const m = res.text.match(/\[[\s\S]*\]/);
      const parsed: unknown = m === null ? [] : JSON.parse(m[0]);
      const reads = (Array.isArray(parsed) ? parsed : [])
        .filter((r): r is { tool: string; input?: Record<string, unknown> } =>
          Boolean(r) && typeof (r as { tool?: unknown }).tool === "string")
        .filter((r) => READ_TOOLS.some((t) => t.name === r.tool));
      return { reads, ms: Date.now() - started, inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0 };
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!/429|overloaded|529|rate|ECONNRESET|timeout|fetch failed/i.test(msg) || attempt === 3) {
        return { reads: [], ms: Date.now() - started, inputTokens: 0, outputTokens: 0, error: msg };
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return { reads: [], ms: Date.now() - started, inputTokens: 0, outputTokens: 0, error: "unreachable" };
};

/** Trim a tool sample: data arrays capped at 2 rows, true rowCount kept. */
const trimSample = (sample: Json, cap: number): { preview: Json; rowCount: number } => {
  if (sample && typeof sample === "object" && !Array.isArray(sample) && Array.isArray((sample as Record<string, Json>).data)) {
    const rec = { ...(sample as Record<string, Json>) };
    const rows = rec.data as Json[];
    rec.data = rows.slice(0, cap);
    return { preview: rec, rowCount: rows.length };
  }
  return { preview: sample, rowCount: Array.isArray(sample) ? sample.length : 1 };
};

const fetchedDigest = (reads: { tool: string; input?: Record<string, unknown> }[]): string => {
  if (reads.length === 0) return "(no host tool matched this request — nothing was read)";
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of reads) {
    if (seen.has(r.tool)) continue;
    seen.add(r.tool);
    const def = MAPLE_TOOLS.find((t) => t.name === r.tool);
    if (def === undefined) continue;
    const { preview, rowCount } = trimSample(def.sample, 2);
    lines.push(`- ${r.tool}(${JSON.stringify(r.input ?? {})}) → rowCount ${rowCount}; shape ${describeShape(MAPLE_TOOL_SHAPES[r.tool]!)}\n  sample: ${JSON.stringify(preview)}`);
  }
  return lines.length === 0 ? "(no host tool matched this request — nothing was read)" : lines.join("\n");
};

// ---------------------------------------------------------------------------
// Judge — opus, blind to arm, against the GROUND TRUTH tool data (the fixture
// samples ARE what the tools return). One call grades both attempts of one
// (prompt, arm) cell; the priority signal is label-truth: claims contradicting
// the data beneath them (the dominant final-gate fail class).
// ---------------------------------------------------------------------------

const groundTruth = (): string => READ_TOOLS
  .map((t) => {
    const { preview, rowCount } = trimSample(t.sample, 3);
    return `- ${t.name} → rowCount ${rowCount}; returns: ${JSON.stringify(preview)}`;
  })
  .join("\n");

export interface Exp5Judgement {
  labelTruthErrors: string[];
  quality: number;
  answersAsk: boolean;
  fabricated: boolean;
  notes: string;
  error?: string;
}

const JUDGE_SYSTEM = `You are grading generated UIs expressed as "vendo wire" markup — a JSX-like tree of components bound to host tool data. The ONLY data source is the host's tools. GROUND TRUTH below is exactly what each read tool returns (sample rows are real; rowCount is the true row count; arrays may be truncated to the first rows shown). Money fields are integer cents; dates are ISO.

GROUND TRUTH TOOL DATA:
${groundTruth()}

For EACH wire given (in order), evaluate:
1. labelTruthErrors — every title, headline, stat label, badge, or copy claim that is FALSE of the data actually bound beneath it or of the ground truth. Examples of errors: a "Total cash" stat bound to one account's balance; "Biggest category: travel" when the ground truth's biggest is payroll; a "total owed" headline bound to a field that is not that total; a period claim ("this quarter", "this month") the bound data does not carry; "most overdue" pointing at a row that is not the most overdue. Judge ONLY claims checkable against the ground truth or the bindings; list each error as one short string; [] when every claim is truthful.
2. quality 1-5: 5 = fully answers the ask, correct components, data traces to real tools, formatting correct, actions wired; 4 = minor issue; 3 = partial/gaps; 2 = weak; 1 = broken/empty/off-ask.
3. answersAsk — substantively addresses the request (an honest disclaimer for an impossible ask counts as addressing it).
4. fabricated — shows business numbers/rows NOT traceable to a tool binding (hand-typed data). A Disclaimer for an unavailable ask is NOT fabrication.

Respond ONLY a JSON array, one object per wire in the order given:
[{"labelTruthErrors":["..."],"quality":<1-5>,"answersAsk":<bool>,"fabricated":<bool>,"notes":"<one sentence>"}, ...]`;

const FALLBACK_JUDGE: Exp5Judgement = { labelTruthErrors: [], quality: 1, answersAsk: false, fabricated: false, notes: "judge unparseable" };

const parseJudgements = (text: string, n: number): Exp5Judgement[] | null => {
  const m = text.match(/\[[\s\S]*\]/);
  if (m === null) return null;
  try {
    const arr: unknown = JSON.parse(m[0]);
    if (!Array.isArray(arr) || arr.length !== n) return null;
    return arr.map((j) => {
      const rec = (j ?? {}) as Partial<Exp5Judgement>;
      return {
        labelTruthErrors: Array.isArray(rec.labelTruthErrors) ? rec.labelTruthErrors.map(String).slice(0, 8) : [],
        quality: Math.max(1, Math.min(5, Math.round(Number(rec.quality ?? 0)))) || 1,
        answersAsk: Boolean(rec.answersAsk),
        fabricated: Boolean(rec.fabricated),
        notes: String(rec.notes ?? "").slice(0, 240),
      };
    });
  } catch {
    return null;
  }
};

const judgeCell = async (prompt: string, wires: string[]): Promise<Exp5Judgement[]> => {
  const nonEmpty = wires.map((w) => w.length >= 8);
  if (!nonEmpty.some(Boolean)) {
    return wires.map(() => ({ ...FALLBACK_JUDGE, notes: "empty output" }));
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await generateText({
        model: judgeModel(),
        system: JUDGE_SYSTEM,
        prompt: `USER REQUEST:\n${prompt}\n\n${wires.map((w, i) => `WIRE ${i + 1}:\n${w.length < 8 ? "(empty output)" : w}`).join("\n\n")}`,
        maxOutputTokens: 1200,
        maxRetries: 0,
      });
      const parsed = parseJudgements(res.text, wires.length);
      if (parsed !== null) {
        return parsed.map((j, i) => nonEmpty[i] ? j : { ...FALLBACK_JUDGE, notes: "empty output" });
      }
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!/429|overloaded|529|rate|timeout|fetch failed/i.test(msg) && attempt === 2) {
        return wires.map(() => ({ ...FALLBACK_JUDGE, notes: "judge error", error: msg }));
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return wires.map(() => FALLBACK_JUDGE);
};

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

export interface Exp5Sample {
  prompt: string;
  negative: boolean;
  arm: "blind" | "fetch";
  attempt: number;
  wire: string;
  genMs: number;
  plannerMs: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  plannerInputTokens: number;
  plannerOutputTokens: number;
  genError?: string;
  metrics: V4Metrics;
  judge: Exp5Judgement;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rate = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0);
const p50 = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

const summarize = (arm: string, samples: Exp5Sample[]) => {
  const ok = samples.filter((s) => s.genError === undefined);
  return {
    arm,
    n: samples.length,
    genErrorRate: rate(samples.map((s) => s.genError !== undefined)),
    compileOkRate: rate(ok.map((s) => s.metrics.compileOk)),
    refErrorFreeRate: rate(ok.map((s) => s.metrics.compileOk && s.metrics.refErrors === 0)),
    meanRefErrors: mean(ok.map((s) => s.metrics.refErrors)),
    meanBindingErrors: mean(ok.map((s) => s.metrics.bindingShapeErrors)),
    bindingErrorFreeRate: rate(ok.map((s) => s.metrics.bindingShapeErrors === 0)),
    meanLabelTruthErrors: mean(ok.map((s) => s.judge.labelTruthErrors.length)),
    labelTruthCleanRate: rate(ok.map((s) => s.judge.labelTruthErrors.length === 0)),
    fabricationRate: rate(ok.map((s) => s.judge.fabricated)),
    answersAskRate: rate(ok.map((s) => s.judge.answersAsk)),
    meanQuality: mean(ok.map((s) => s.judge.quality)),
    qualityStdev: stdev(ok.map((s) => s.judge.quality)),
    p50GenMs: p50(ok.map((s) => s.genMs)),
    p50TotalMs: p50(ok.map((s) => s.totalMs)),
    meanTotalMs: mean(ok.map((s) => s.totalMs)),
    meanPlannerMs: mean(ok.map((s) => s.plannerMs)),
    p50OutputTokens: p50(ok.map((s) => s.outputTokens)),
    meanInputTokens: mean(ok.map((s) => s.inputTokens + s.plannerInputTokens)),
    meanOutputTokens: mean(ok.map((s) => s.outputTokens + s.plannerOutputTokens)),
  };
};

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("W1 Exp5: fetch-then-generate vs blind, both on the v4 create contract", () => {
  it("A/B on compile, binding errors, label-truth, latency, tokens", { timeout: 3_600_000 }, async () => {
    const deps: GenerationDependencies = { ...DEPS, model: genModel() };
    const system = wireContractV4(deps);
    const userTask = (prompt: string): string => `TASK: CREATE_APP\nUSER_REQUEST: ${prompt}`;

    // Phase 1 once per prompt (its latency/tokens are charged to EVERY arm-B
    // attempt — production would run it per generation; noted in the report).
    const planners = new Map<string, PlannerResult>();
    await pool(PROMPTS, 3, async (prompt) => {
      planners.set(prompt, await planReads(prompt));
    });

    interface Cell { prompt: string; arm: "blind" | "fetch"; attempt: number }
    const cells: Cell[] = PROMPTS.flatMap((prompt) =>
      (["blind", "fetch"] as const).flatMap((arm) =>
        Array.from({ length: ATTEMPTS }, (_, attempt) => ({ prompt, arm, attempt }))));

    const samples = await pool(cells, 3, async ({ prompt, arm, attempt }): Promise<Exp5Sample> => {
      const planner = arm === "fetch" ? planners.get(prompt)! : undefined;
      const task = planner === undefined
        ? userTask(prompt)
        : `${userTask(prompt)}\nFETCHED DATA (these read tools were already executed for this request; rowCounts and sample rows are REAL — bind these exact fields and make every headline, label, and claim true of this data):\n${fetchedDigest(planner.reads)}`;
      const g = await generateWire(system, task);
      return {
        prompt,
        negative: EXP5_NEGATIVE_PROMPTS.includes(prompt),
        arm,
        attempt,
        wire: g.wire,
        genMs: g.ms,
        plannerMs: planner?.ms ?? 0,
        totalMs: g.ms + (planner?.ms ?? 0),
        inputTokens: g.inputTokens,
        outputTokens: g.outputTokens,
        plannerInputTokens: planner?.inputTokens ?? 0,
        plannerOutputTokens: planner?.outputTokens ?? 0,
        ...(g.error === undefined ? {} : { genError: g.error }),
        metrics: computeV4Metrics(g.wire),
        judge: FALLBACK_JUDGE, // filled below
      };
    });

    // Judge per (prompt, arm) cell — 2 wires per call, blind to arm.
    const cellsToJudge = PROMPTS.flatMap((prompt) => (["blind", "fetch"] as const).map((arm) => ({ prompt, arm })));
    await pool(cellsToJudge, 3, async ({ prompt, arm }) => {
      const cellSamples = samples
        .filter((s) => s.prompt === prompt && s.arm === arm)
        .sort((a, b) => a.attempt - b.attempt);
      const judged = await judgeCell(prompt, cellSamples.map((s) => s.wire));
      cellSamples.forEach((s, i) => { s.judge = judged[i] ?? FALLBACK_JUDGE; });
    });

    const blind = samples.filter((s) => s.arm === "blind");
    const fetch_ = samples.filter((s) => s.arm === "fetch");
    const positives = (arr: Exp5Sample[]) => arr.filter((s) => !s.negative);
    const negatives = (arr: Exp5Sample[]) => arr.filter((s) => s.negative);

    const artifact = {
      experiment: "exp5-fetch-then-generate-v4-revisit",
      generatedAt: new Date().toISOString(),
      config: {
        contract: "wireContractV4 (pipeline.promptRewrite: true; endPass off; single-shot, no repair)",
        genModel: process.env.W1_GEN_MODEL ?? "claude-sonnet-4-6",
        judgeModel: process.env.W1_JUDGE_MODEL ?? "claude-opus-4-8",
        prompts: PROMPTS.length,
        negatives: EXP5_NEGATIVE_PROMPTS.length,
        attemptsPerArm: ATTEMPTS,
        digestRowCap: 2,
      },
      summaries: {
        all: [summarize("A: blind (v4)", blind), summarize("B: fetch-then-generate (v4)", fetch_)],
        positives: [summarize("A: blind (v4, positives)", positives(blind)), summarize("B: fetch (v4, positives)", positives(fetch_))],
        negatives: [summarize("A: blind (v4, negatives)", negatives(blind)), summarize("B: fetch (v4, negatives)", negatives(fetch_))],
      },
      planner: [...planners.entries()].map(([prompt, plan]) => ({ prompt, reads: plan.reads, ms: plan.ms, error: plan.error })),
      samples,
    };
    const path = writeRaw("exp5-fetch-v4.json", artifact);

    // eslint-disable-next-line no-console
    console.log(`\n=== EXP5 (fetch-then-generate v4 revisit) ===\n${JSON.stringify(artifact.summaries, null, 2)}\nraw: ${path}\n`);

    expect(blind.length).toBe(PROMPTS.length * ATTEMPTS);
    expect(fetch_.length).toBe(PROMPTS.length * ATTEMPTS);
  });
});
