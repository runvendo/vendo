/**
 * The workbench — the dev-only diagnostics channel (`VENDO_WORKBENCH=1`).
 *
 * Everything here goes through the REAL wire: a real `vendo()` turn on the real
 * runtime, written by the real `UIMessageStreamWriter` and read back off the real
 * SSE response. A suite that collected the facts from the sink directly would
 * prove the sink talks to itself — the claim is that a fact a loop emitted
 * arrives at a browser, and only the wire can say that.
 *
 * Two claims, and the first one is the product one:
 *  - flag unset, the channel does not exist: no part, anywhere, ever;
 *  - flag set, the turn's own steps, calls and compaction arrive in the order
 *    they happened, numbered, under this turn's id.
 */
import type { Harness, ThreadId } from "@vendoai/core";
import { simulateReadableStream, MockLanguageModelV3 } from "ai/test";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarnessRuntime, type TurnRunInput } from "../src/runtime.js";
import { vendo, type VendoHarnessOptions } from "../src/vendo/vendo.js";
import { VENDO_DEBUG_PART } from "../src/wire.js";
import type { WorkbenchEvent, WorkbenchPart } from "../src/workbench.js";
import {
  boundRegistry,
  ctx,
  readSse,
  readTool,
  scriptedModel,
  seats,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  textTurn,
  toolCallTurn,
  userMessage,
  ZERO_USAGE,
  type TestTool,
} from "../src/test-doubles.test-util.js";

const THREAD = "thr_workbench" as ThreadId;

afterEach(() => {
  delete process.env.VENDO_WORKBENCH;
});

/** One `vendo()` turn on the real runtime, drained as a host route drains it. */
function fixture(model: LanguageModel, tools: Record<string, TestTool> = {}) {
  const guard = testGuard();
  const transcript = testTranscript();
  const runtime = createHarnessRuntime({
    tools: boundRegistry(tools, guard),
    guard,
    skills: testSkills(),
    transcript,
  });
  const run = async (
    over: Partial<TurnRunInput<VendoHarnessOptions>> = {},
  ): Promise<Array<Record<string, unknown>>> =>
    readSse(await runtime.run<VendoHarnessOptions>({
      harness: vendo() as Harness<VendoHarnessOptions>,
      threadId: THREAD,
      messages: [userMessage("m1", "what is my balance?")],
      ctx: ctx(),
      workspace: testWorkspace(),
      models: seats(model),
      interactive: true,
      ...over,
    }));
  return { run, transcript };
}

/** The workbench's own parts, off the wire, in wire order. */
const facts = (parts: Array<Record<string, unknown>>): WorkbenchPart[] =>
  parts
    .filter((part) => part.type === VENDO_DEBUG_PART)
    .map((part) => part.data as WorkbenchPart);

const kinds = (parts: WorkbenchPart[]): WorkbenchEvent["kind"][] =>
  parts.map((part) => part.event.kind);

const only = <K extends WorkbenchEvent["kind"]>(
  parts: WorkbenchPart[],
  kind: K,
): Array<Extract<WorkbenchEvent, { kind: K }>> =>
  parts
    .map((part) => part.event)
    .filter((event): event is Extract<WorkbenchEvent, { kind: K }> => event.kind === kind);

/** A turn that calls one tool and then answers. */
const answeringModel = (): LanguageModel =>
  scriptedModel([toolCallTurn("balance", { account: "checking" }), textTurn("You have $10.")]);

const balanceTool = (): Record<string, TestTool> => ({
  balance: { descriptor: readTool("balance"), execute: () => ({ amount: 10 }) },
});

describe("the flag is the whole gate", () => {
  it("emits NOTHING when VENDO_WORKBENCH is unset — no part reaches the wire", async () => {
    const f = fixture(answeringModel(), balanceTool());
    const parts = await f.run();
    // The turn really ran: a tool was called and an answer came back.
    expect(parts.some((part) => part.type === "tool-output-available")).toBe(true);
    expect(facts(parts)).toEqual([]);
    expect(parts.some((part) => String(part.type).includes("debug"))).toBe(false);
  });
});

describe("with the flag set, the turn narrates itself", () => {
  it("puts step boundaries and the guarded call on the wire, numbered, under one turn id", async () => {
    process.env.VENDO_WORKBENCH = "1";
    const f = fixture(answeringModel(), balanceTool());
    const parts = facts(await f.run());
    expect(parts.length).toBeGreaterThan(0);

    // One turn, one sequence: `seq` is dense and ordered, and every part names
    // the turn the runtime minted.
    const turnIds = new Set(parts.map((part) => part.turnId));
    expect(turnIds.size).toBe(1);
    expect([...turnIds][0]).toMatch(/^trn_[0-9a-f]{32}$/);
    expect(parts.map((part) => part.seq)).toEqual(parts.map((_part, index) => index));
    expect(parts.every((part) => part.agent === "resident")).toBe(true);
    expect(parts.every((part) => part.at > 0)).toBe(true);

    // Two steps: the tool call, then the answer.
    expect(only(parts, "step-start").map((event) => event.step)).toEqual([0, 1]);
    const firstStep = only(parts, "step-start")[0]!;
    expect(firstStep.maxSteps).toBe(20);
    expect(firstStep.activeTools).toContain("balance");
    expect(only(parts, "step-end").map((event) => event.stopReason)).toEqual(["tool-calls", "stop"]);
    expect(only(parts, "step-end").every((event) => event.durationMs >= 0)).toBe(true);

    // The call, as the guarded path actually decided it.
    const call = only(parts, "tool")[0]!;
    expect(call.name).toBe("balance");
    expect(call.status).toBe("ok");
    expect(call.guard).toBe("run");
    expect(call.approval).toBe("auto");
    expect(call.argsPreview).toContain("checking");
    expect(call.step).toBe(0);
    // …and it is filed inside the step that made it, not after the step ended.
    expect(kinds(parts).indexOf("tool")).toBeLessThan(kinds(parts).indexOf("step-end"));

    // The loadout the brain equipped, and the window it measured itself against.
    const loadout = only(parts, "loadout")[0]!;
    expect(loadout.active).toContain("balance");
    const context = only(parts, "context")[0]!;
    expect(context.triggerTokens).toBeLessThan(context.windowTokens);
    expect(context.estTokens).toBeGreaterThan(0);
  });

  it("is screen-only: not one debug part lands in the transcript", async () => {
    process.env.VENDO_WORKBENCH = "1";
    const f = fixture(answeringModel(), balanceTool());
    await f.run();
    const stored = await f.transcript.list({ kind: "user", subject: "u1" }, THREAD);
    expect(JSON.stringify(stored)).not.toContain(VENDO_DEBUG_PART);
    expect(JSON.stringify(stored)).not.toContain("step-start");
  });
});

describe("the two endings a turn can have that its steps do not say", () => {
  it("names the step cap that stopped the turn", async () => {
    process.env.VENDO_WORKBENCH = "1";
    // One permitted step, and a model that still wanted a tool call after it: the
    // turn ended because of the cap, not because the model was finished.
    const f = fixture(scriptedModel([toolCallTurn("balance", { account: "checking" })]), balanceTool());
    const parts = facts(await f.run({ options: { maxSteps: 1 } }));
    expect(only(parts, "step-start").map((event) => event.maxSteps)).toEqual([1]);
    expect(only(parts, "step-limit")).toEqual([{ kind: "step-limit", steps: 1 }]);
    // …and it is the LAST thing the turn says: the cap is only knowable once the
    // stream has drained.
    expect(kinds(parts).at(-1)).toBe("step-limit");
  });

  it("puts a hired sub-run on the resident's own channel, under its own seat", async () => {
    process.env.VENDO_WORKBENCH = "1";
    // Three provider calls, in the order the turn makes them: the resident hires,
    // the specialist answers, the resident answers. `hire_subagent` is the
    // harness's own hand, so it is spelled here rather than imported.
    const f = fixture(
      scriptedModel([
        toolCallTurn("hire_subagent", { instructions: "check the issuer rules" }),
        textTurn("Rule R-118 rejects that category."),
        textTurn("An issuer rule is blocking the card."),
      ]),
      balanceTool(),
    );
    const parts = facts(await f.run());

    const hire = only(parts, "subagent");
    expect(hire).toEqual([{
      kind: "subagent",
      label: "check the issuer rules",
      steps: 1,
      maxSteps: 12,
      report: "Rule R-118 rejects that category.",
    }]);

    // One turn, one dense sequence — the hire's parts are interleaved with the
    // resident's rather than carried on a channel of their own.
    expect(new Set(parts.map((part) => part.turnId)).size).toBe(1);
    expect(parts.map((part) => part.seq)).toEqual(parts.map((_part, index) => index));
    const seats = parts.map((part) => part.agent);
    expect(new Set(seats)).toEqual(new Set(["resident", "subagent"]));
    // The hire's whole run is filed INSIDE a resident step: the resident is still
    // speaking after the specialist has reported.
    expect(seats.slice(seats.lastIndexOf("subagent") + 1)).toContain("resident");

    // Each seat counts its OWN steps from zero, which is the only thing that keeps
    // the resident's step 0 and the hire's step 0 apart on one stream.
    const seat = (agent: WorkbenchPart["agent"]) => parts.filter((part) => part.agent === agent);
    expect(only(seat("resident"), "step-start").map((event) => event.step)).toEqual([0, 1]);
    expect(only(seat("subagent"), "step-start").map((event) => event.step)).toEqual([0]);
    // The hire builds its own prompt, so it measures its own window too.
    expect(only(seat("subagent"), "context")).toHaveLength(1);
    // …and the hiring call itself never reaches the wire: a hand runs in-process
    // and only `turn.tools.call()` is a `tool` fact.
    expect(only(parts, "tool").map((event) => event.name)).not.toContain("hire_subagent");
  });
});

/** A thread big enough that the tail alone exceeds the preserved budget, so the
 *  cut has something above it to summarize. */
const hugeThread = (): UIMessage[] => [
  userMessage("m1", `JANUARY STATEMENTS ${"o".repeat(60_000)}`),
  { id: "m2", role: "assistant", parts: [{ type: "text", text: `NOTES ${"a".repeat(60_000)}` }] },
  userMessage("m3", "so what is my balance?"),
];

/** A seat that summarizes on `generateText` and answers on `streamText` — the
 *  thread's own seat does both, which is what compaction is. */
const compactingSeat = (summary: string, reply: string): LanguageModel =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: summary }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: ZERO_USAGE,
      warnings: [],
    }),
    doStream: async () => ({ stream: simulateReadableStream({ chunks: textTurn(reply) }) }),
  }) as unknown as LanguageModel;

describe("compaction", () => {
  it("reports the summary the summarizer actually wrote", async () => {
    process.env.VENDO_WORKBENCH = "1";
    const summary = "## Goal\nThe user is reconciling January statements.";
    const f = fixture(compactingSeat(summary, "You have $10."));
    const history = hugeThread();
    // The past arrives from the store, as a real thread's does — a client may not
    // post the assistant's own words (`validateUpsert`).
    for (const [seq, message] of history.slice(0, -1).entries()) {
      await f.transcript.upsert({ kind: "user", subject: "u1" }, THREAD, message, seq);
    }
    const parts = facts(await f.run({
      messages: history,
      // A window this thread cannot fit in, so the trigger trips on the estimate.
      options: { contextWindowTokens: 1_000 },
    }));
    const compaction = only(parts, "compaction")[0];
    expect(compaction).toBeDefined();
    expect(compaction!.reason).toBe("trigger");
    expect(compaction!.summary).toBe(summary);
  });
});
