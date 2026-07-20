/**
 * W1-bench (docs/verification/w1-bench) — the live-model client. Generation
 * runs on the production full-lane model (claude-sonnet-4-6); the LLM judge
 * runs on an independent stronger model (claude-opus-4-8) to avoid
 * self-preference bias. A/B arms always share the generator model.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";

export const GEN_MODEL = process.env.W1_GEN_MODEL ?? "claude-sonnet-4-6";
export const JUDGE_MODEL = process.env.W1_JUDGE_MODEL ?? "claude-opus-4-8";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const genModel = (): LanguageModel => anthropic(GEN_MODEL) as LanguageModel;
export const judgeModel = (): LanguageModel => anthropic(JUDGE_MODEL) as LanguageModel;

export interface GenResult {
  text: string;
  wire: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  error?: string;
}

/** Extract the wire: everything from the first `<App` through the last `</App>`. */
export const extractWire = (text: string): string => {
  const start = text.indexOf("<App");
  if (start === -1) return text.trim();
  const closeTag = "</App>";
  const close = text.lastIndexOf(closeTag);
  return close === -1 ? text.slice(start) : text.slice(start, close + closeTag.length);
};

const withRetry = async <T>(fn: () => Promise<T>, label: string): Promise<T> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String((err as { message?: string })?.message ?? err);
      if (!/429|overloaded|529|rate|ECONNRESET|timeout|fetch failed/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1) + Math.random() * 1000));
    }
  }
  throw new Error(`${label}: exhausted retries: ${String(lastErr)}`);
};

export interface GenOptions {
  thinkingBudget?: number;
  maxOutputTokens?: number;
  maxSteps?: number;
}

export const generateWire = async (
  system: string,
  prompt: string,
  opts: GenOptions = {},
): Promise<GenResult> => {
  const started = Date.now();
  try {
    const res = await withRetry(() =>
      generateText({
        model: genModel(),
        system,
        prompt,
        maxOutputTokens: opts.maxOutputTokens ?? 6000,
        maxRetries: 0,
        ...(opts.thinkingBudget
          ? { providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: opts.thinkingBudget } } } }
          : {}),
      }), "generateWire");
    return {
      text: res.text,
      wire: extractWire(res.text),
      inputTokens: res.usage?.inputTokens ?? 0,
      outputTokens: res.usage?.outputTokens ?? 0,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { text: "", wire: "", inputTokens: 0, outputTokens: 0, ms: Date.now() - started, error: String((err as Error)?.message ?? err) };
  }
};

/** Tool-call generation (Experiment 2 Arm B): one assistant turn, extended
 *  thinking on, strict tools. Returns the ordered tool calls + usage. */
export interface ToolCallResult {
  calls: { toolName: string; input: Record<string, unknown> }[];
  inputTokens: number;
  outputTokens: number;
  ms: number;
  error?: string;
}

export const generateToolCalls = async (
  system: string,
  prompt: string,
  tools: ToolSet,
  opts: GenOptions = {},
): Promise<ToolCallResult> => {
  const started = Date.now();
  try {
    const messages: ModelMessage[] = [{ role: "user", content: prompt }];
    const res = await withRetry(() =>
      generateText({
        model: genModel(),
        system,
        messages,
        tools,
        toolChoice: "auto",
        // The builder emits a batch of calls, gets no-op results, and continues
        // until the app is fully composed (or the step cap). This is how "one
        // logical build" maps onto the tool-use protocol.
        stopWhen: stepCountIs(opts.maxSteps ?? 16),
        maxOutputTokens: opts.maxOutputTokens ?? 12000,
        maxRetries: 0,
        ...(opts.thinkingBudget
          ? { providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: opts.thinkingBudget } } } }
          : {}),
      }), "generateToolCalls");
    const calls = (res.steps ?? []).flatMap((s) => s.toolCalls ?? []).map((c) => ({
      toolName: c.toolName,
      input: (c.input ?? {}) as Record<string, unknown>,
    }));
    return {
      calls,
      inputTokens: res.usage?.inputTokens ?? 0,
      outputTokens: res.usage?.outputTokens ?? 0,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { calls: [], inputTokens: 0, outputTokens: 0, ms: Date.now() - started, error: String((err as Error)?.message ?? err) };
  }
};

/** Phase-1 read planner: ask the model for a JSON array (no thinking) and
 *  parse it leniently. Returns [] on any failure. */
export const generateModelJsonList = async (
  system: string,
  prompt: string,
): Promise<{ tool?: string; input?: Record<string, unknown> }[]> => {
  try {
    const res = await withRetry(() =>
      generateText({ model: genModel(), system, prompt, maxOutputTokens: 800, maxRetries: 0 }), "planner");
    const m = res.text.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/** Bounded-concurrency map over async work. */
export const pool = async <T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
};
