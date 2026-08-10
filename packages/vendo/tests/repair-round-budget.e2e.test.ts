/**
 * THE REPAIR ROUND IS ONE CALL WITH ONE HAND.
 *
 * The mandatory reviewer pass is the safety net that catches what no lookup can
 * (`mandatory-reviewer.e2e.test.ts` holds the incident it exists for). What it
 * used to COST when it found something is the subject here: it started a second
 * full drive of the assembly loop, with a fresh `SCREEN_STEPS` budget and the whole
 * loadout, on the far side of a screen the person was already looking at. Over the
 * 34 reviewed screens in the app-gen bench (072edfff8) the 7 that found something
 * spent a median 94.8s there — up to 214.8s — and 4 of the 7 spent steps back in
 * `search_components`, shopping for components instead of applying fixes they had
 * already been handed.
 *
 * A repair is not an open-ended job: it is told the locus and the real alternative,
 * and the document rides on the message. So it gets one model call and one tool.
 *
 * This walks a REAL composed deployment — real store, guard, apps pack, render
 * seam, checks floor and `validate` verb — and reads the budget off what the
 * PROVIDER was asked, because that is the only place a step and a loadout are
 * observable. The ones that must be able to fail: raise `REPAIR_STEPS`
 * (`packages/vendo/src/screen-agent.ts`) and the call count goes red; hand the
 * repair the assembly loadout and the loadout assertion goes red.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VENDO_MAKE_TOOL,
  type Json,
  type Principal,
  type ToolDefinition,
  type ToolResult,
} from "@vendoai/core";
import { makeReceiptSchema } from "@vendoai/apps/contract";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_repair_budget" };

const ROWS = [
  { id: "txn_1", name: "Coffee", amount_cents: 480 },
  { id: "txn_2", name: "Groceries", amount_cents: 6_240 },
] as const;

const hostTools: ToolDefinition[] = [
  {
    name: "host_transactions",
    title: "Transactions",
    description: "This month's transactions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
    execute: async () => ({ data: ROWS as unknown as Json }) as unknown as Json,
  },
];

/** A document that passes every mechanical check, so the reviewer is the only
 *  thing left that could object to it — which is the case under test. */
const document = (label: string): string => `<App name="Spending">
  <Query id="rows" tool="host_transactions"/>
  <Stat label="${label}" value={sum(rows.data, "amount_cents")} format="money"/>
  <DataTable rows={rows.data} columns={[{key:"name",label:"Merchant"},{key:"amount_cents",format:"money",align:"end"}]} emptyState="Nothing yet"/>
</App>`;

const FIRST = document("Total spend, both cards");
const CORRECTED = document("Total spend");

const FINDING = 'the label says "both cards" and only one card is queried — say "Total spend"';

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

/** The screen agent's own brief (`environmentNote`) — how a prompt is known to
 *  belong to a writing loop rather than to a check. */
const SCREEN_BRIEF_MARKER = "# In this loop";
/** The reviewer's own rubric (`REVIEWER_SYSTEM`). */
const REVIEWER_MARKER = "You are the last reader of a generated app";

interface Walked {
  /** Every prompt a writing loop was handed, in order. Its LENGTH is the step
   *  count, which is the budget assertion. */
  writerPrompts: string[];
  /** What the model was allowed to pick on each of those calls. */
  writerTools: string[][];
  reviewerCalls: number;
  /** The `vendo_make` receipt, as the resident read it. */
  result: ToolResult | undefined;
}

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-repair-budget-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** One real `vendo_make` ask through the real screen route, with only the model
 *  scripted: the writing loop streams and the reviewer generates, so the two
 *  scripts cannot leak into each other. */
async function walk(steps: Array<() => Chunk[]>): Promise<Walked> {
  const store = await tempStore();
  const writerPrompts: string[] = [];
  const writerTools: string[][] = [];
  let reviewerCalls = 0;
  const remaining = [...steps];
  const textOf = (request: { prompt?: unknown }): string => JSON.stringify(request.prompt ?? "");
  const namesOf = (request: { tools?: unknown }): string[] =>
    Array.isArray(request.tools)
      ? request.tools.map((tool) => String((tool as { name?: unknown }).name))
      : [];
  const model = {
    specificationVersion: "v2",
    provider: "vendo-repair-budget",
    modelId: "vendo-repair-budget-v1",
    supportedUrls: {},
    async doGenerate(request: { prompt?: unknown }) {
      if (!textOf(request).includes(REVIEWER_MARKER)) {
        return {
          content: [{ type: "text", text: "" }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      reviewerCalls += 1;
      return {
        content: [{
          type: "tool-call",
          toolCallId: "review_1",
          toolName: "report_findings",
          input: JSON.stringify({
            findings: [{ severity: "block", where: '<Stat> labeled "Total spend, both cards"', message: FINDING }],
          }),
        }],
        finishReason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream(request: { prompt?: unknown; tools?: unknown }) {
      const prompt = textOf(request);
      const chunks = prompt.includes(SCREEN_BRIEF_MARKER)
        ? (remaining.shift() ?? (() => speak("nothing more to do")))()
        : speak("nothing to do here");
      if (prompt.includes(SCREEN_BRIEF_MARKER)) {
        writerPrompts.push(prompt);
        writerTools.push(namesOf(request));
      }
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
  let result: ToolResult | undefined;
  const harness = defineHarness({
    name: "repair-budget-probe",
    async *run(turn) {
      result = await turn.tools.call(VENDO_MAKE_TOOL, { request: "what did I spend this month" });
      yield { type: "text", delta: "ok" };
    },
  });
  const vendo = createVendo({
    model: model as unknown as LanguageModel,
    principal: async () => principal,
    store,
    tools: hostTools,
    harness: harness as never,
  } as Parameters<typeof createVendo>[0]);
  const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thr_repair_budget",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "what did I spend this month" }] },
    }),
  }));
  expect(response.status).toBe(200);
  await response.text();
  return { writerPrompts, writerTools, reviewerCalls, result };
}

describe("what a review that finds something costs", () => {
  it("repairs in one model call, with save_app as the only tool", async () => {
    const walked = await walk([
      () => call("save_app", { content: FIRST }, "c1"),
      () => speak("Your spending is on your screen."),
      // The repair round. Under a fresh loop budget this save would be step one of
      // ten, and the loop would keep going.
      () => call("save_app", { content: CORRECTED }, "c2"),
    ]);

    // The reviewer was spent once, and found something.
    expect(walked.reviewerCalls).toBe(1);
    // Two writing steps for the screen, and exactly ONE for the repair.
    expect(walked.writerPrompts).toHaveLength(3);
    // …which had one hand and no catalog to shop in.
    expect(walked.writerTools[2]).toEqual(["save_app"]);
    // The assembly loop is untouched: it still gets the verbs and the door out.
    expect(walked.writerTools[0]).toContain("escalate");
    expect(walked.writerTools[0]).toContain("validate");
    // And the one call is told what is wrong, shown the document, and told it has
    // one save.
    const repair = walked.writerPrompts[2] ?? "";
    expect(repair).toContain("`validate` does not pass");
    // The reviewer's own sentence, which appears nowhere in the document.
    expect(repair).toContain("only one card is queried");
    expect(repair).toContain("This is the document you saved");
    expect(repair).toContain("this is your only step");
    // The screen the person already has is still theirs.
    const receipt = makeReceiptSchema.parse((walked.result as { output: unknown }).output);
    expect(receipt.status).toBe("ready");
  }, 120_000);
});
