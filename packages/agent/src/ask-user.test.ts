import { ASK_USER_TOOL, type RunContext, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { askUserRegistry } from "./ask-user.js";
import { createAgent } from "./index.js";
import {
  ctx as agentCtx,
  readSse,
  scriptedModel,
  testGuard,
  textTurn,
  toolCallTurn,
  userMessage,
} from "./test-helpers.js";

const ctx = (overrides: Partial<RunContext> = {}): RunContext => ({
  principal: { kind: "user", subject: "user_alice" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
  ...overrides,
});

const call = (args: unknown) => ({ id: "call_1", tool: ASK_USER_TOOL, args: args as never });

describe("ask_user — questions as a tool, one door, any seat (design §4)", () => {
  it("is named ask_user and is a read: asking costs no grant", async () => {
    const [descriptor] = await askUserRegistry().descriptors();
    expect(descriptor?.name).toBe("ask_user");
    expect(descriptor?.risk).toBe("read");
  });

  it("records the question and tells the model to ask it and stop", async () => {
    // The record IS the mirrored tool call plus the audit row — there is no
    // pending-question registry and no answer door. So the observable contract is
    // that the question comes back in the output, where the transcript keeps it.
    const outcome = await askUserRegistry().execute(
      call({ question: "  Which account?  ", choices: ["savings", "joint"] }),
      ctx(),
    );

    expect(outcome.status).toBe("ok");
    expect(outcome).toMatchObject({
      output: { asked: "Which account?", choices: ["savings", "joint"] },
    });
    // The model is told the turn is over. Without this it guesses an answer and
    // carries on, which is the one thing this tool exists to prevent.
    expect(JSON.stringify(outcome)).toMatch(/final message/);
  });

  it("takes NOTHING from the model but the question — no thread, no answer, no id", async () => {
    // A caller-chosen thread id used to be the danger here: the transcript is what
    // the next turn reads, so writing into someone else's conversation would be
    // agent steering, not just defacement. The door now writes nowhere at all, so
    // there is no id to smuggle and no row to aim at.
    const outcome = await askUserRegistry().execute(
      call({ question: "Which?", threadId: "thr_victim", questionId: "q_reused", answer: "spoofed" }),
      ctx(),
    );

    expect(outcome.status).toBe("ok");
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("thr_victim");
    expect(serialized).not.toContain("q_reused");
    expect(serialized).not.toContain("spoofed");
  });

  it("REFUSES in an unattended run — there is nobody there to ask", async () => {
    // A question with no one to answer it is not a question. An automation that
    // needs an answer must fail with a card, not hang and not invent one.
    const outcome = await askUserRegistry().execute(
      call({ question: "Which account?" }),
      ctx({ venue: "automation", presence: "away" }),
    );

    expect(outcome.status).toBe("blocked");
  });

  it("is not projected into an unattended run at all", async () => {
    const projected = await askUserRegistry().descriptors({ venue: "automation", presence: "away" });
    expect(projected).toEqual([]);
  });

  it("rejects a blank question rather than registering an empty one", async () => {
    const outcome = await askUserRegistry().execute(call({ question: "  " }), ctx());
    expect(outcome.status).toBe("error");
  });
});

describe("a question ENDS the turn (design §6, build contract §8)", () => {
  /**
   * The REAL registry is handed to `createAgent` as its toolset, not a
   * `boundRegistry` double. That is load-bearing: the double wraps whatever its
   * implementation returns in `{ status: "ok", output: ... }`, so every outcome —
   * a refusal included — reads as ok to a stop condition. `guardedCall` returns
   * the registry's `ToolOutcome` verbatim as the tool output, which is the shape
   * `askedUserStop` actually sees in production.
   */
  const counted = (): { tools: ToolRegistry; calls: () => number } => {
    const inner = askUserRegistry();
    let calls = 0;
    return {
      calls: () => calls,
      tools: {
        descriptors: (runCtx) => inner.descriptors?.(runCtx) ?? Promise.resolve([]),
        execute: async (toolCall, runCtx) => {
          calls += 1;
          return inner.execute(toolCall, runCtx);
        },
      },
    };
  };

  it("stops after the question instead of taking another step", async () => {
    const registry = counted();
    // ONE scripted turn. If the loop asked the model for a second step after the
    // question, the scripted model would throw ("scripted model exhausted") and
    // the stream would carry an error part — so a clean [DONE] IS the stop.
    const model = scriptedModel([
      toolCallTurn(ASK_USER_TOOL, { question: "Which account?" }, "call_ask_1"),
    ]);
    const agent = createAgent({ model, tools: registry.tools, guard: testGuard({}) });

    const response = await agent.stream({
      threadId: "thr_asked",
      message: userMessage("user_asked", "move some money"),
      ctx: agentCtx(),
    });
    const { parts } = await readSse(response);

    expect(parts.filter((part) => part.type === "error")).toEqual([]);
    expect(registry.calls()).toBe(1);
    // The question really is in the mirrored tool output — that IS the record,
    // there is no question row anywhere else.
    expect(JSON.stringify(parts)).toContain("Which account?");
  });

  it("does NOT stop on a refused question — the model still finishes what it can", async () => {
    // A blank or unattended question is not an answer pending; ending the turn on
    // it would strand work the model could still do.
    const registry = counted();
    const model = scriptedModel([
      // A blank question → `error`, so the loop must continue...
      toolCallTurn(ASK_USER_TOOL, { question: "   " }, "call_ask_blank"),
      // ...and this SECOND scripted turn is only reached if it did.
      textTurn("I could not ask, so here is what I know."),
    ]);
    const agent = createAgent({ model, tools: registry.tools, guard: testGuard({}) });

    const response = await agent.stream({
      threadId: "thr_asked_blank",
      message: userMessage("user_asked_blank", "do something"),
      ctx: agentCtx(),
    });
    const { parts } = await readSse(response);

    expect(parts.filter((part) => part.type === "error")).toEqual([]);
    expect(parts.some((part) => JSON.stringify(part).includes("here is what I know"))).toBe(true);
  });
});
