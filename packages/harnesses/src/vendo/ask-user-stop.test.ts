/**
 * Design §4 + §6 — a question through the one door ENDS the turn.
 *
 * The law's only direct tests lived in the umbrella's `ask-user.test.ts` and
 * drove `createAgent`; they died with it. The stop condition (`askedUserStop`)
 * lives beside this file now, so the proof does too.
 *
 * Both halves matter and they pull in opposite directions: an ANSWERED question
 * must stop the loop (carrying on is exactly the invention `ask_user` exists to
 * prevent — the model guesses an answer, and the user's real reply lands a turn
 * too late), while a REFUSED one must NOT (a blank or unattended question is not
 * an answer pending, and ending there strands work the model could still do).
 *
 * The registry here is hand-rolled rather than `boundRegistry`: the double wraps
 * whatever its implementation returns in `{status:"ok"}`, so a refusal would read
 * as answered and the second case could never fail.
 */
import { ASK_USER_TOOL, type Json, type ToolOutcome, type ToolRegistry, type Turn } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { vendo } from "./vendo.js";
import { createTurnState } from "../harness-state.js";
import { createTurnTools } from "../turn-tools.js";
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
} from "../test-doubles.test-util.js";

/** One turn against a two-step script. The loop only reaches the SECOND scripted
 *  step if it took another step after the question — so the model's call count IS
 *  the assertion. */
async function askAndCount(outcome: ToolOutcome): Promise<number> {
  const registry: ToolRegistry = {
    descriptors: async () => [readTool(ASK_USER_TOOL, "read")],
    execute: async () => outcome,
  };
  const guard = testGuard();
  const turnTools = createTurnTools({ registry, guard, ctx: ctx(), interactive: true, mirror: () => {} });
  const model = scriptedModel([
    toolCallTurn(ASK_USER_TOOL, { question: "Which account?" }),
    textTurn("I went ahead without waiting."),
  ]);
  const turn: Turn = {
    messages: [userMessage("m1", "move some money")],
    tools: turnTools,
    skills: testSkills(),
    workspace: testWorkspace(),
    models: seats(model),
    state: createTurnState(undefined),
    options: {},
    signal: new AbortController().signal,
    interactive: true,
  };
  // Drained, not inspected: what this measures is how many times the loop went
  // back to the model.
  for await (const _event of vendo().run(turn)) void _event;
  turnTools.dispose();
  return model.calls;
}

describe("a question ends the turn", () => {
  it("stops after an answered ask_user instead of taking another step", async () => {
    const calls = await askAndCount({ status: "ok", output: { question: "Which account?" } as Json });
    expect(calls).toBe(1);
  });

  it("does NOT stop on a refused question — the model still finishes what it can", async () => {
    const calls = await askAndCount({
      status: "error",
      error: { code: "validation", message: "a question needs text" },
    });
    expect(calls).toBe(2);
  });
});
