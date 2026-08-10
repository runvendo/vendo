/**
 * A turn NEVER ends without words.
 *
 * There were two ways for `vendo()` to go quiet, and both of them looked like a
 * finished turn from the outside:
 *
 *  1. an abort was answered with a bare `return` — no reply, no failure, so the
 *     caller could not tell a silent success from a dead turn;
 *  2. `askedUserStop` ends the turn the instant `ask_user` returns ok, which
 *     leaves no step in which to ask — while the tool's own output tells the
 *     model to put the question to the user as its final message.
 *
 * The scripts here carry exactly as many turns as the loop is allowed to take,
 * so a fix that bought its words with another provider round-trip fails on
 * "scripted model exhausted" rather than passing quietly.
 */
import { ASK_USER_TOOL, type HarnessEvent, type Json, type ToolRegistry, type Turn } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { vendo, type VendoHarnessOptions } from "../../src/vendo/vendo.js";
import { createTurnState } from "../../src/harness-state.js";
import { createTurnTools, type RuntimeTurnTools } from "../../src/turn-tools.js";
import {
  ctx,
  readTool,
  scriptedModel,
  seats,
  testGuard,
  testSkills,
  testWorkspace,
  textTurn,
  toolCallTurn,
  userMessage,
  ZERO_USAGE,
  type StreamPart,
} from "../../src/test-doubles.test-util.js";

/** A registry offering `ask_user` alone, which answers every question. Hand-rolled
 *  rather than `boundRegistry` for the same reason `ask-user-stop.test.ts` does it:
 *  the double would wrap any outcome in `{status:"ok"}`. */
function askUserDouble(): ToolRegistry {
  return {
    descriptors: async () => [readTool(ASK_USER_TOOL, "read")],
    // Deliberately EMPTY output: the question this suite expects to hear back is
    // the one the model wrote as the call's argument, so no registry echo can be
    // what makes these pass.
    execute: async () => ({ status: "ok", output: {} as Json }),
  };
}

function turnFor(
  model: ReturnType<typeof scriptedModel>,
  tools: RuntimeTurnTools,
  signal: AbortSignal = new AbortController().signal,
): Turn<VendoHarnessOptions> {
  return {
    threadId: "thr_silent",
    turnId: "trn_silent",
    messages: [userMessage("m1", "move some money")],
    tools,
    skills: testSkills(),
    workspace: testWorkspace(),
    models: seats(model),
    state: createTurnState(undefined),
    options: {},
    signal,
    interactive: true,
  };
}

const spoken = (events: readonly HarnessEvent[]): string =>
  events.flatMap((event) => (event.type === "text" ? [event.delta] : [])).join("");

const failures = (events: readonly HarnessEvent[]): Extract<HarnessEvent, { type: "error" }>[] =>
  events.flatMap((event) => (event.type === "error" ? [event] : []));

describe("a turn never ends without words", () => {
  it("delivers an ask_user question as the reply, with no second round-trip", async () => {
    const tools = createTurnTools({
      registry: askUserDouble(),
      guard: testGuard(),
      ctx: ctx(),
      interactive: true,
      mirror: () => {},
    });
    const model = scriptedModel([
      toolCallTurn(ASK_USER_TOOL, {
        question: "Which account should I move it from?",
        choices: ["Checking", "Savings"],
      }),
    ]);
    const events: HarnessEvent[] = [];
    for await (const event of vendo().run(turnFor(model, tools))) events.push(event);
    tools.dispose();

    expect(spoken(events)).toContain("Which account should I move it from?");
    // The choices are part of the question the model asked, and they ride the
    // same argument.
    expect(spoken(events)).toContain("Checking");
    expect(spoken(events)).toContain("Savings");
    // The whole point: the words cost nothing.
    expect(model.calls).toBe(1);
  });

  it("does NOT ask twice when the step that asked already spoke", async () => {
    const tools = createTurnTools({
      registry: askUserDouble(),
      guard: testGuard(),
      ctx: ctx(),
      interactive: true,
      mirror: () => {},
    });
    const askWhileSpeaking: StreamPart[] = [
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Which account should I move it from?" },
      { type: "text-end", id: "t1" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: ASK_USER_TOOL,
        input: JSON.stringify({ question: "Which account should I move it from?" }),
      },
      { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
    ];
    const model = scriptedModel([askWhileSpeaking]);
    const events: HarnessEvent[] = [];
    for await (const event of vendo().run(turnFor(model, tools))) events.push(event);
    tools.dispose();

    const asked = spoken(events).split("Which account should I move it from?").length - 1;
    expect(asked).toBe(1);
  });

  it("says what happened when the turn is aborted, and reports the failure", async () => {
    const tools = createTurnTools({
      registry: { descriptors: async () => [], execute: async () => ({ status: "ok", output: {} as Json }) },
      guard: testGuard(),
      ctx: ctx(),
      interactive: true,
      mirror: () => {},
    });
    const model = scriptedModel([textTurn("On it — pulling your accounts")]);
    const controller = new AbortController();
    const events: HarnessEvent[] = [];
    // Hung up on mid-sentence, which is the shape of every real abort: a stop
    // button, or a lane's per-turn budget.
    for await (const event of vendo().run(turnFor(model, tools, controller.signal))) {
      events.push(event);
      if (event.type === "text") controller.abort();
    }
    tools.dispose();

    expect(spoken(events)).toContain("stopped before it finished");
    expect(failures(events).map((event) => event.code)).toEqual(["aborted"]);
  });
});
