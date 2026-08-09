import { ASK_USER_TOOL, type RunContext } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { askUserRegistry } from "../src/ask-user.js";

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
