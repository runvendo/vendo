/**
 * EVERY FINISHED SCREEN FACES THE REVIEWER, WITH THE EVIDENCE.
 *
 * Live 2026-08-06 (demo-bank, "make me a dashboard for my upcoming bills and
 * subscriptions"): the screen summed two overlapping query results into one
 * headline — $11,216 where the truth was ~$6,276. Every mechanical check passed,
 * because a double count is not a shape error: the binding was well typed, the
 * field existed, the tool was real. The AI reviewer is the only check that could
 * have caught it, and it never ran — it fires only when the writing model
 * volunteers to call `validate({appId})`, and this one did not.
 *
 * So this walks a REAL composed deployment — real store, real guard, real apps
 * pack, real render seam, the real checks floor, the real `validate` verb, real
 * host tools returning real overlapping rows — and asserts what happens to a
 * finished screen whose writer never asked to be checked. Only the model is
 * scripted, because what is measured is the doors, not a provider's mood.
 *
 * The ones that must be able to fail:
 * - drop `review: true` from the gate call in `assembleScreen`
 *   (`packages/vendo/src/screen-agent.ts`) and case 1 goes red — the reviewer
 *   is never called and the double count ships, which is the incident.
 * - stop passing `samples` to `reviewerCheck` (`packages/apps/src/runtime.ts`) and
 *   case 1 goes red at the evidence assertion — the reviewer double cannot see the
 *   overlap it is asked to judge, so it reports nothing, exactly as the live
 *   reviewer would have.
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
import {
  makeReceiptSchema,
} from "@vendoai/apps/contract";
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

const principal: Principal = { kind: "user", subject: "user_mandatory_reviewer" };

/**
 * The host's two reads, and the trap between them: three of the five bills ARE
 * the subscriptions, by id. Nothing on either result says so — which is why only
 * something holding both row sets at once can see the overlap.
 */
const BILLS = [
  { id: "bill_rent", name: "Rent", amount_cents: 180_000, due_at: "2026-08-01" },
  { id: "bill_power", name: "Power", amount_cents: 9_600, due_at: "2026-08-04" },
  { id: "bill_netflix", name: "Netflix", amount_cents: 1_999, due_at: "2026-08-09" },
  { id: "bill_adobe", name: "Adobe Creative Cloud", amount_cents: 5_999, due_at: "2026-08-12" },
  { id: "bill_aws", name: "AWS", amount_cents: 12_000, due_at: "2026-08-18" },
] as const;

/** The subscriptions are a SUBSET of the bills — same ids, same amounts. */
const SUBSCRIPTIONS = BILLS.filter(({ id }) => ["bill_netflix", "bill_adobe", "bill_aws"].includes(id));

const hostTools: ToolDefinition[] = [
  {
    name: "host_upcomingBills",
    title: "Upcoming bills",
    description: "Every bill due in the next 30 days.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
    execute: async () => ({ data: BILLS as unknown as Json }) as unknown as Json,
  },
  {
    name: "host_subscriptions",
    title: "Subscriptions",
    description: "The recurring subscriptions on this account.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
    execute: async () => ({ data: SUBSCRIPTIONS as unknown as Json }) as unknown as Json,
  },
];

/**
 * The incident in miniature: one headline that adds both query results, so every
 * subscription is counted twice. Both bindings are well typed and both tools are
 * real, so the whole mechanical floor passes it.
 */
const DOUBLE_COUNT = `<App name="Upcoming bills">
  <Query id="bills" tool="host_upcomingBills"/>
  <Query id="subs" tool="host_subscriptions"/>
  <Stat label="Due this month" value={sum(bills.data, "amount_cents") + sum(subs.data, "amount_cents")} format="money"/>
  <DataTable rows={bills.data} columns={[{key:"name",label:"Bill"},{key:"amount_cents",format:"money",align:"end"}]} emptyState="Nothing due"/>
</App>`;

/** The same screen, honest: the headline sums the bills alone. */
const HONEST = `<App name="Upcoming bills">
  <Query id="bills" tool="host_upcomingBills"/>
  <Stat label="Due this month" value={sum(bills.data, "amount_cents")} format="money"/>
  <DataTable rows={bills.data} columns={[{key:"name",label:"Bill"},{key:"amount_cents",format:"money",align:"end"}]} emptyState="Nothing due"/>
</App>`;

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

/** The screen agent's own brief (`environmentNote`) — how a prompt is known to be
 *  the assembly loop's. */
const SCREEN_BRIEF_MARKER = "# In this loop";
/** The reviewer's own rubric (`REVIEWER_SYSTEM`) — how a prompt is known to be its. */
const REVIEWER_MARKER = "You are the last reader of a generated app";

interface Scripted {
  model: LanguageModel;
  /** Every prompt the assembly loop was handed, in order. Each one carries the
   *  results of every tool call before it — which is where "what the loop was
   *  told" is readable. */
  writerPrompts: string[];
  /** Every prompt the REVIEWER was handed. One per finished screen is the whole
   *  approved cost, so the length is the cost assertion. */
  reviewerPrompts: string[];
}

/**
 * One model wearing both hats, split by the call KIND rather than by a flag: the
 * assembly loop streams (`doStream`) and the reviewer's strict tool call generates
 * (`doGenerate`). So the two scripts cannot leak into each other, and the reviewer
 * prompt count is a real count of reviewer model calls.
 */
function scripted(
  steps: Array<(prompt: string) => Chunk[]>,
  review: (prompt: string) => { findings: unknown } | Error,
): Scripted {
  const writerPrompts: string[] = [];
  const reviewerPrompts: string[] = [];
  const remaining = [...steps];
  const answer = (prompt: string): Chunk[] => {
    if (!prompt.includes(SCREEN_BRIEF_MARKER)) return speak("nothing to do here");
    const step = remaining.shift();
    return step === undefined ? speak("nothing more to do") : step(prompt);
  };
  const textOf = (request: { prompt?: unknown }): string => JSON.stringify(request.prompt ?? "");
  const model = {
    specificationVersion: "v2",
    provider: "vendo-mandatory-reviewer",
    modelId: "vendo-mandatory-reviewer-v1",
    supportedUrls: {},
    async doGenerate(request: { prompt?: unknown }) {
      const prompt = textOf(request);
      if (!prompt.includes(REVIEWER_MARKER)) {
        return {
          content: [{ type: "text", text: "" }],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      reviewerPrompts.push(prompt);
      const verdict = review(prompt);
      // A transport failure, as the live reviewer meets it: the request simply
      // throws, and `strictToolCall` swallows it into no findings.
      if (verdict instanceof Error) throw verdict;
      return {
        content: [{
          type: "tool-call",
          toolCallId: "review_1",
          toolName: "report_findings",
          input: JSON.stringify(verdict),
        }],
        finishReason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async doStream(request: { prompt?: unknown }) {
      const prompt = textOf(request);
      writerPrompts.push(prompt);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const chunk of answer(prompt)) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  };
  return { model: model as unknown as LanguageModel, writerPrompts, reviewerPrompts };
}

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-mandatory-reviewer-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** One real `vendo_make` ask, served by the real screen route. */
async function walk(
  steps: Array<(prompt: string) => Chunk[]>,
  review: (prompt: string) => { findings: unknown } | Error,
): Promise<{
  result: ToolResult | undefined;
  writerPrompts: string[];
  reviewerPrompts: string[];
  chunks: Array<Record<string, unknown>>;
  vendo: ReturnType<typeof createVendo>;
}> {
  const store = await tempStore();
  const { model, writerPrompts, reviewerPrompts } = scripted(steps, review);
  let result: ToolResult | undefined;
  const harness = defineHarness({
    name: "mandatory-reviewer-probe",
    async *run(turn) {
      result = await turn.tools.call(VENDO_MAKE_TOOL, {
        request: "make me a dashboard for my upcoming bills and subscriptions",
      });
      yield { type: "text", delta: "ok" };
    },
  });
  const vendo = createVendo({
    model,
    principal: async () => principal,
    store,
    tools: hostTools,
    harness: harness as never,
  } as Parameters<typeof createVendo>[0]);
  const response = await vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thr_mandatory_reviewer",
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "my upcoming bills" }] },
    }),
  }));
  const raw = await response.text();
  expect(response.status).toBe(200);
  const chunks = raw
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map((block) => JSON.parse(block.slice("data: ".length)) as Record<string, unknown>);
  return { result, writerPrompts, reviewerPrompts, chunks, vendo };
}

const saveApp = (content: string, id: string) => () => call("save_app", { content }, id);

/** No findings, whatever it is shown. */
const NOTHING_WRONG = () => ({ findings: [] });

const OVERLAP_MESSAGE =
  'the headline adds both queries, and bill_netflix, bill_adobe and bill_aws are in BOTH — '
  + 'sum(bills.data, "amount_cents") alone is the real total';

/**
 * A reviewer that reports the double count only when it can actually SEE it: both
 * query results in front of it, with the same row ids in each. Same app, same
 * rubric — the only thing that can produce the finding is the evidence, so a red
 * here is the evidence missing rather than a scripted constant going quiet.
 */
const readerCheckingTheRows = (prompt: string): { findings: unknown } => {
  const shared = ["bill_netflix", "bill_adobe", "bill_aws"];
  const sawBoth = prompt.includes("bills: ") && prompt.includes("subs: ");
  const counted = shared.filter((id) => prompt.split(id).length - 1 >= 2);
  return sawBoth && counted.length === shared.length
    ? { findings: [{ severity: "block", where: '<Stat> labeled "Due this month"', message: OVERLAP_MESSAGE }] }
    : { findings: [] };
};

describe("the mandatory reviewer pass on a finished screen", () => {
  it("catches a headline that contradicts its own rows, though the writer never called validate", async () => {
    const walked = await walk([
      // The writer's WHOLE turn: save the double-counting document, then speak.
      // It never calls `validate` — which used to mean nothing judged this screen.
      saveApp(DOUBLE_COUNT, "c1"),
      () => speak("Your upcoming bills are on your screen."),
    ], readerCheckingTheRows);

    // Two writer steps and no more: the save and the sentence. There is no
    // validate call in this script, which is the whole premise.
    expect(walked.writerPrompts).toHaveLength(3);

    // THE REVIEWER RAN ANYWAY — exactly once, which is the approved cost.
    expect(walked.reviewerPrompts).toHaveLength(1);

    // …and it ran with the ROWS behind the screen, fetched through the same
    // guard-bound registry the screen itself reads from.
    const reviewed = walked.reviewerPrompts[0] ?? "";
    expect(reviewed).toContain("RESOLVED_DATA");
    expect(reviewed).toContain("bill_rent");
    expect(reviewed).toContain("bill_netflix");
    // Both query results, keyed by the query's own name — which is the only way
    // the overlap is visible at all.
    expect(reviewed).toMatch(/bills: /);
    expect(reviewed).toMatch(/subs: /);
    // And it is asked to check aggregates, not only literals.
    expect(reviewed).toContain("AN AGGREGATE THAT DISAGREES WITH ITS OWN ROWS");

    // ONE repair round, in the loop's own words: the third writer prompt is the
    // reviewer's finding, handed over verbatim by the shipped gate.
    const repair = walked.writerPrompts[2] ?? "";
    expect(repair).toContain("`validate` does not pass");
    expect(repair).toContain("bill_netflix, bill_adobe and bill_aws are in BOTH");
    // With the document in front of it, so the repair is a fix rather than a
    // rewrite from nothing.
    expect(repair).toContain("This is the document you saved");
  }, 120_000);

  it("a clean screen passes: nothing to repair, and one reviewer call all the same", async () => {
    const walked = await walk([
      saveApp(HONEST, "c1"),
      () => speak("Your upcoming bills are on your screen."),
    ], readerCheckingTheRows);

    const receipt = makeReceiptSchema.parse((walked.result as { output: unknown }).output);
    expect(receipt.status).toBe("ready");
    expect(receipt.title).toBe("Upcoming bills");
    // The reviewer was spent — the pass is mandatory, not conditional on suspicion.
    expect(walked.reviewerPrompts).toHaveLength(1);
    // …and had nothing to say, so the loop was never asked for a repair round.
    expect(walked.writerPrompts).toHaveLength(2);
    expect(walked.writerPrompts.join("\n")).not.toContain("does not pass");
    expect(walked.chunks.filter((chunk) => chunk["type"] === "data-vendo-view").length).toBeGreaterThan(0);
  }, 120_000);

  it("a reviewer that cannot be reached never costs the person their screen", async () => {
    // Infrastructure failure, not a verdict: the request throws. Fail-open is the
    // reviewer's documented posture — "silence, refusal, or a failed request all
    // mean no findings" — and the mandatory pass must not have turned that into a
    // gate that eats a good screen.
    const walked = await walk([
      saveApp(HONEST, "c1"),
      () => speak("Your upcoming bills are on your screen."),
    ], () => new Error("529 overloaded"));

    const receipt = makeReceiptSchema.parse((walked.result as { output: unknown }).output);
    expect(receipt.status).toBe("ready");
    // It was asked, and it fell over.
    expect(walked.reviewerPrompts).toHaveLength(1);
    // No repair round invented out of a failed request.
    expect(walked.writerPrompts).toHaveLength(2);
    // The screen reached the person and the row reached the store.
    expect(walked.chunks.filter((chunk) => chunk["type"] === "data-vendo-view").length).toBeGreaterThan(0);
    const stored = await walked.vendo.apps.get(receipt.id, { principal, venue: "chat", presence: "present", sessionId: "ses_reviewer" });
    expect(stored?.name).toBe("Upcoming bills");
  }, 120_000);

  it("never judges a screen that did not pass the mechanical floor", async () => {
    // Bytes that land and never paint. Not a finished screen, so the reviewer must
    // not be spent on it — the floor's own sentences are the answer, and they are
    // free.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const walked = await walk([
      saveApp("not a document at all", "c1"),
      () => speak("done"),
    ], NOTHING_WRONG);

    expect(walked.reviewerPrompts).toHaveLength(0);
  }, 120_000);
});
