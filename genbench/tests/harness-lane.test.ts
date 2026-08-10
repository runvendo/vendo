/**
 * The harness lane's SEAM: the real product on one side, the lane's recorder on
 * the other, and nothing stubbed in between.
 *
 * `runHarnessCase` composes `createVendo` — the default `vendo()` harness, a real
 * guard, a real store and transcript, the real system prompt — and drives it
 * through `vendo.harness.stream`, the door a host's chat route calls. The ONLY
 * substitution here is the model: a scripted brain, so what these tests measure
 * is the product's own plumbing and this lane's reading of it rather than a
 * model's mood.
 *
 * That is the point of testing it this way. The trace comes off the product's own
 * wire mirror, the canned rows come back through the guard-bound registry, and the
 * failure injection and the approval round trip are the shipped paths — so if any
 * of those move, these fail. A harness bench whose harness is a mock proves
 * nothing.
 */
import type { ToolRegistry } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { harnessChecks, harnessPasses, type HarnessCase } from "../src/harness-checks.js";
import { benchRegistry, harnessWorld, runHarnessCase, WALL_CLOCK_FAILURE } from "../src/harness-lane.js";
import type { Meter, UsageTotals } from "../src/meter.js";
import { loadWorld, type World } from "../src/world.js";

const NO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 };

/** A meter around a scripted brain. The real one wraps a provider; nothing here
 *  is billed, and the lane only ever reads these four members. */
const meterOf = (model: LanguageModel): Meter => ({
  model,
  elapsedMs: () => 0,
  totals: () => NO_USAGE,
  usd: () => 0,
});

type Chunk = Record<string, unknown>;

const ZERO = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

const says = (text: string): Chunk[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  { type: "finish", usage: ZERO, finishReason: { unified: "stop", raw: undefined } },
];

const invokes = (toolName: string, input: unknown, toolCallId = `call_${toolName}`): Chunk[] => [
  { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
  { type: "finish", usage: ZERO, finishReason: { unified: "tool-calls", raw: undefined } },
];

/** One scripted step per provider call, in order, across every turn of the case.
 *  `offered` is what each call was actually allowed to pick from — the only place
 *  a test can prove the world reached the model at all. */
function scripted(steps: Chunk[][]): LanguageModel & { offered: string[][] } {
  const remaining = steps.map((step) => [...step]);
  const offered: string[][] = [];
  const model = new MockLanguageModelV3({
    doStream: async (request: { tools?: ReadonlyArray<{ name: string }> }) => {
      offered.push((request.tools ?? []).map((tool) => tool.name));
      const chunks = remaining.shift();
      if (chunks === undefined) throw new Error("scripted model exhausted");
      return { stream: simulateReadableStream({ chunks: chunks as never }) };
    },
  }) as unknown as LanguageModel & { offered: string[][] };
  model.offered = offered;
  return model;
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let maple: World | undefined;
const world = async (): Promise<World> => (maple ??= await loadWorld(join(root, "worlds", "maple")));

const caseOf = (over: Partial<HarnessCase> & { id: string }): HarnessCase => ({
  kind: "harness",
  turns: ["do the thing"],
  ...over,
});

describe("driving the real vendo() harness", () => {
  it(
    "records every call, its arguments, and the world's own rows as the result",
    async () => {
      const testCase = caseOf({
        id: "seam-two-turns",
        turns: ["What's my smallest pending transfer?", "Cancel that one."],
        expectCalls: [{ tool: "list_transfers" }, { tool: "cancel_transfer", args: { id: "tr_2" } }],
        maxToolCalls: 3,
      });
      const model = scripted([
        invokes("list_transfers", { limit: 10 }),
        says("The smallest is $60.00 to Jordan Avery."),
        invokes("cancel_transfer", { id: "tr_2" }),
        says("Cancelled."),
      ]);

      const turns = await runHarnessCase({
        world: harnessWorld(await world(), testCase),
        testCase,
        meter: meterOf(model),
      });

      // The world reached the model. Without this a live run would read as a
      // product that refuses every ask, when the truth would be that this lane
      // never handed it the host's API.
      expect(model.offered[0]).toEqual(
        expect.arrayContaining(["list_accounts", "get_spending", "list_transfers", "cancel_transfer"]),
      );

      expect(turns).toHaveLength(2);
      expect(turns[0]?.reply).toBe("The smallest is $60.00 to Jordan Avery.");
      expect(turns[1]?.reply).toBe("Cancelled.");

      // The trace is the product's own mirror, so the arguments are what the
      // model really sent and the output is what the guard-bound registry really
      // answered with — the world's canned rows, not a copy of them.
      const listed = turns[0]?.calls[0];
      expect(listed?.tool).toBe("list_transfers");
      expect(listed?.args).toEqual({ limit: 10 });
      expect(listed?.status).toBe("ok");
      expect(JSON.stringify(listed?.output)).toContain("tr_2");
      expect(turns[1]?.calls[0]).toMatchObject({ tool: "cancel_transfer", args: { id: "tr_2" }, status: "ok" });

      // …and the case's contract reads that trace and passes.
      const checks = harnessChecks({
        testCase,
        turns,
        worldTools: (await world()).tools.map((tool) => tool.name),
      });
      expect(harnessPasses(checks), JSON.stringify(checks)).toBe(true);
    },
    180_000,
  );

  it(
    "makes a case's first-call failure reach the model, and the retry succeed",
    async () => {
      const testCase = caseOf({
        id: "seam-recovery",
        turns: ["Cancel the transfer to Jordan Avery."],
        tools: {
          list_transfers: { fail: "first", error: { code: "unavailable", message: "the transfers service is down" } },
        },
      });
      const model = scripted([
        invokes("list_transfers", { limit: 10 }, "call_1"),
        invokes("list_transfers", { limit: 10 }, "call_2"),
        says("Done."),
      ]);

      const turns = await runHarnessCase({
        world: harnessWorld(await world(), testCase),
        testCase,
        meter: meterOf(model),
      });

      const calls = turns[0]?.calls ?? [];
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ tool: "list_transfers", status: "error" });
      expect(calls[0]?.why).toContain("the transfers service is down");
      expect(calls[1]?.status).toBe("ok");
    },
    180_000,
  );

  it(
    "runs a gated write through the real approval round trip, and records the refusal",
    async () => {
      const testCase = caseOf({
        id: "seam-gate",
        gate: "deny",
        turns: ["Cancel my transfer to Alex Rivera."],
        expectCalls: [{ tool: "cancel_transfer", args: { id: "tr_1" } }],
      });
      const model = scripted([invokes("cancel_transfer", { id: "tr_1" }), says("That one was refused.")]);

      const turns = await runHarnessCase({
        world: harnessWorld(await world(), testCase),
        testCase,
        meter: meterOf(model),
      });

      // `cautious` + a person who says no: the guard parks the write, the lane's
      // responder answers it through `guard.approvals.decide`, and the model gets
      // a denial rather than a ninety-second wait.
      expect(turns[0]?.calls[0]).toMatchObject({ tool: "cancel_transfer", status: "denied" });
      expect(turns[0]?.reply).toBe("That one was refused.");
    },
    180_000,
  );

  it(
    "reads a case's own tool, derived exactly like an authored one",
    async () => {
      const testCase = caseOf({
        id: "seam-case-tool",
        turns: ["Did I spend more on food last month?"],
        tools: {
          get_spending_last_month: {
            does: "LAST month's spending per category. Amounts in CENTS.",
            data: { data: [{ category: "dining", amount: 61080 }] },
          },
        },
      });
      const scoped = harnessWorld(await world(), testCase);
      expect(scoped.tools.map((tool) => tool.name)).toContain("get_spending_last_month");

      const model = scripted([invokes("get_spending_last_month", {}), says("Last month, yes.")]);
      const turns = await runHarnessCase({ world: scoped, testCase, meter: meterOf(model) });

      expect(turns[0]?.calls[0]).toMatchObject({ tool: "get_spending_last_month", status: "ok" });
      expect(JSON.stringify(turns[0]?.calls[0]?.output)).toContain("61080");
    },
    180_000,
  );

  /**
   * A tool that never answers is a real hang: the per-turn abort signal rides on
   * the model stream and cannot rescue a step that is still waiting on a call. Take
   * the case's own wall clock away and this test does not fail — it never returns,
   * and neither does the lane run it is standing in for.
   */
  it(
    "gives up on a tool call that never answers, and records that case as failed instead of hanging",
    async () => {
      const testCase = caseOf({ id: "seam-wall-clock", turns: ["What's my smallest pending transfer?"] });
      const scoped = harnessWorld(await world(), testCase);
      const real = benchRegistry(scoped, testCase);
      // The world's own listing, behind a call that never comes back.
      const hangs: ToolRegistry = {
        descriptors: async (ctx) => await real.descriptors(ctx),
        execute: async () => await new Promise(() => undefined),
      };
      const model = scripted([invokes("list_transfers", { limit: 10 })]);

      const turns = await runHarnessCase({
        world: scoped,
        testCase,
        meter: meterOf(model),
        registry: hangs,
        turnTimeoutMs: 1_000,
      });

      expect(turns).toHaveLength(1);
      expect(turns[0]?.failure).toBe(WALL_CLOCK_FAILURE);
      // …and the lane scores that as the case failing, rather than dropping a case
      // that never answered out of the run.
      const checks = harnessChecks({ testCase, turns, worldTools: scoped.tools.map((tool) => tool.name) });
      expect(harnessPasses(checks)).toBe(false);
      expect(checks[0]).toMatchObject({ name: "answered", pass: false });
    },
    30_000,
  );
});
