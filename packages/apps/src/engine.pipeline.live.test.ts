/**
 * W4 pipeline live harness — measures the reliability pipeline on the real
 * create path against the demo-bank host surface (catalog + tools +
 * hand-written shape cards mirroring apps/demo-bank/src/server/types.ts).
 *
 * NOT part of the gate: guarded by PIPE_MODE so `pnpm test` never runs it
 * (no keys, no cost).
 *
 *   PIPE_MODE=run PIPE_VARIANT=baseline|repair|parallel|endpass [PIPE_PROMPTS=0,3,7]
 *
 * Variants:
 *   baseline — structured repair OFF (the pre-W4 free-form loop)
 *   repair   — structured repair ON (the new default)
 *   parallel — repair + outline/region-parallel tier-2
 *   endpass  — repair + the no-think end pass
 *
 * Samples append to docs/verification/w4-pipeline/samples.ndjson (gitignored);
 * the README table is the aggregate. Env: ANTHROPIC_API_KEY (keys live at
 * /Users/yousefh/orca/workspaces/flowlet/.env — never commit).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { LanguageModel } from "ai";
import { describe, it } from "vitest";
import type { NormalizedCatalog, ShapeType } from "@vendoai/core";
import {
  modelEngine,
  type GenerationDependencies,
  type GenerationTimingEvent,
  type HostToolInfo,
} from "./engine.js";
import type { PipelineEvent } from "./pipeline.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const samplesPath = resolve(repoRoot, "docs/verification/w4-pipeline/samples.ndjson");

const FULL_MODEL = process.env.VENDO_PIPE_FULL_MODEL ?? "claude-sonnet-4-6";

/** ~10 live dev prompts across the demo-bank surface: read-heavy views,
 *  chart/table splits, and mutation asks (transfer/schedule/reminders) that
 *  exercise the action-honesty + payload-skeleton classes. */
const PROMPTS = [
  "Build me a net-worth dashboard with my total balance, a balance-over-time chart, and my recent transactions.",
  "Show my budgets with how much I've spent in each category and flag the ones over 80% of their limit.",
  "A spending breakdown: a donut of spending by category next to a table of this month's biggest transactions.",
  "Show my savings goals with progress toward each target and how much is left to save.",
  "List my upcoming scheduled payments and let me pay one now.",
  "A subscriptions view: my recurring charges, what they cost per month, and when each renews.",
  "Cashflow overview: money in vs money out per month as a chart, plus my current account balances.",
  "Show my cards with their limits and status, and the latest transactions per card.",
  "A transfers screen: pick a payee and move money to them from my checking account.",
  "An alerts inbox: my notifications, newest first, with unread ones highlighted.",
];

const loadCatalog = (): NormalizedCatalog => {
  const raw = JSON.parse(readFileSync(resolve(repoRoot, "apps/demo-bank/.vendo/catalog.json"), "utf8")) as {
    entries: Array<{ name: string; description: string; propsSchema: unknown; examples?: string[] }>;
  };
  return raw.entries.map((e) => ({
    name: e.name,
    description: e.description,
    propsJsonSchema: e.propsSchema as NormalizedCatalog[number]["propsJsonSchema"],
    ...(e.examples === undefined ? {} : { examples: e.examples }),
  })) as NormalizedCatalog;
};

const loadTools = (): HostToolInfo[] => {
  const raw = JSON.parse(readFileSync(resolve(repoRoot, "apps/demo-bank/.vendo/tools.json"), "utf8")) as {
    tools: Array<{ name: string; description: string; risk: string; inputSchema?: Record<string, unknown> }>;
  };
  return raw.tools
    .filter(({ name }) => !name.startsWith("host_auth") && !name.startsWith("host_demo") && !name.startsWith("host_voice"))
    .map(({ name, description, risk, inputSchema }) => ({
      name,
      description,
      risk,
      ...(inputSchema === undefined ? {} : { inputSchema }),
    }));
};

// Shape cards mirroring apps/demo-bank/src/server/types.ts — what runtime
// shape-sampling would derive from live responses.
const str: ShapeType = { kind: "string" };
const num: ShapeType = { kind: "number" };
const bool: ShapeType = { kind: "boolean" };
const arr = (items: ShapeType): ShapeType => ({ kind: "array", items });
const obj = (fields: Record<string, ShapeType>): ShapeType => ({ kind: "object", fields });

const account = obj({
  id: str, name: str, kind: str, mask: str, balance: num,
  accountNumber: str, sparkline: arr(num),
});
const transaction = obj({
  id: str, accountId: str, merchant: str, descriptor: str, amount: num,
  timestamp: str, category: str, status: str, method: str,
});
const page = (items: ShapeType): ShapeType => obj({ data: arr(items), total: num });

const toolShapes: Record<string, ShapeType> = {
  host_getProfile: obj({ name: str, email: str, netWorth: num, accountCount: num, avatarInitials: str }),
  host_listAccounts: arr(account),
  host_getAccount: account,
  host_listTransactions: page(transaction),
  host_listAccountTransactions: page(transaction),
  host_getTransaction: transaction,
  host_listCards: arr(obj({
    id: str, accountId: str, type: str, network: str, mask: str,
    expMonth: num, expYear: num, frozen: bool, design: str,
  })),
  host_listCardTransactions: page(transaction),
  host_getBudgets: arr(obj({ category: str, limit: num, spent: num })),
  host_listGoals: arr(obj({ id: str, name: str, target: num, saved: num, icon: str })),
  host_listPayees: arr(obj({ id: str, name: str, kind: str })),
  host_listScheduledPayments: arr(obj({
    id: str, payeeId: str, payeeName: str, amount: num, nextDate: str, cadence: str,
  })),
  host_getSpendingInsights: arr(obj({ category: str, amount: num })),
  host_getCashflowInsights: arr(obj({ label: str, in: num, out: num })),
  host_getRecurringInsights: arr(obj({
    id: str, merchant: str, amount: num, cadence: str, category: str, nextDate: str,
  })),
  host_listNotifications: arr(obj({
    id: str, kind: str, title: str, body: str, at: str, read: bool,
  })),
};

const anthropicModel = async (id: string): Promise<LanguageModel> => {
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("ANTHROPIC_API_KEY missing — source /Users/yousefh/orca/workspaces/flowlet/.env");
  }
  return createAnthropic({ apiKey })(id);
};

type Variant = "baseline" | "repair" | "parallel" | "endpass";

const pipelineFor = (variant: Variant): GenerationDependencies["pipeline"] => {
  if (variant === "baseline") return { structuredRepair: false };
  if (variant === "parallel") return { regionParallel: true };
  if (variant === "endpass") return { endPass: true };
  return {};
};

interface Sample {
  variant: Variant;
  promptIndex: number;
  ok: boolean;
  error?: string;
  completeMs: number;
  fullAttempts: number;
  timing: GenerationTimingEvent[];
  pipeline: PipelineEvent[];
  nodes?: number;
  queries?: number;
}

const runOnce = async (
  variant: Variant,
  promptIndex: number,
  model: LanguageModel,
): Promise<Sample> => {
  const timing: GenerationTimingEvent[] = [];
  const pipeline: PipelineEvent[] = [];
  const deps = {
    model,
    catalog: loadCatalog(),
    tools: loadTools(),
    toolShapes,
    pipeline: pipelineFor(variant),
    onTiming: (event: GenerationTimingEvent) => timing.push(event),
    onPipeline: (event: PipelineEvent) => pipeline.push(event),
  } as unknown as GenerationDependencies;
  const start = Date.now();
  let sample: Sample;
  try {
    const document = await modelEngine.create({ prompt: PROMPTS[promptIndex] as string }, deps);
    const tree = document.tree as unknown as { nodes: unknown[]; queries?: unknown[] };
    sample = {
      variant,
      promptIndex,
      ok: true,
      completeMs: Date.now() - start,
      fullAttempts: timing.filter((event) => event.lane === "full" && event.phase === "complete").length,
      timing,
      pipeline,
      nodes: tree.nodes.length,
      queries: tree.queries?.length ?? 0,
    };
  } catch (error) {
    sample = {
      variant,
      promptIndex,
      ok: false,
      error: error instanceof Error ? `${error.message} :: ${JSON.stringify((error as { details?: unknown }).details ?? [])}`.slice(0, 800) : "unknown",
      completeMs: Date.now() - start,
      fullAttempts: timing.filter((event) => event.lane === "full" && event.phase === "complete").length,
      timing,
      pipeline,
    };
  }
  appendFileSync(samplesPath, `${JSON.stringify(sample)}\n`);
  const repair = sample.pipeline.find((event) => event.stage === "repair");
  const parallel = sample.pipeline.find((event) => event.stage === "region-parallel");
  // eslint-disable-next-line no-console
  console.log(`[pipe:${variant}:${promptIndex}] ok=${sample.ok} complete=${sample.completeMs}ms attempts=${sample.fullAttempts}`
    + (repair !== undefined && repair.stage === "repair" ? ` repair(rounds=${repair.rounds} fixed=${repair.repaired} noFix=${repair.noValidFix} ${repair.ms}ms)` : "")
    + (parallel !== undefined && parallel.stage === "region-parallel" ? ` parallel(fallback=${parallel.fallback ?? "none"} ${parallel.sectionsLanded ?? "-"}/${parallel.sectionsPlanned ?? "-"} ${parallel.ms}ms)` : ""));
  return sample;
};

const mode = process.env.PIPE_MODE;
const TIMEOUT = 1_800_000;

describe.runIf(mode === "run")("W4 pipeline live harness", () => {
  const variant = (process.env.PIPE_VARIANT ?? "repair") as Variant;
  const indices = (process.env.PIPE_PROMPTS ?? PROMPTS.map((_, index) => index).join(","))
    .split(",").map((raw) => Number(raw.trim())).filter((index) => Number.isInteger(index) && index >= 0 && index < PROMPTS.length);

  it(`variant=${variant} prompts=${indices.join(",")}`, { timeout: TIMEOUT }, async () => {
    const model = await anthropicModel(FULL_MODEL);
    for (const index of indices) {
      await runOnce(variant, index, model);
    }
  });
});
