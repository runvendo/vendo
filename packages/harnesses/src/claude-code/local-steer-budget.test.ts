/**
 * `machine: "local"` had no message budget, and a steer that the SDK answers
 * with FEWER results than the session counted wedged the whole thread.
 *
 * **The seam, and why this file doubles the SDK rather than the session.**
 * `createClaudeSession` (`@vendoai/apps/claude-turn`) counts the extra `result`
 * messages a steer is expected to produce, and `local.ts` awaits `send()` until
 * one of them settles the turn. Those are a producer and a consumer of the same
 * invariant, and every existing test doubles one of them:
 *
 *   - `local-session.test.ts` doubles the whole `ClaudeSession`, so its `steer`
 *     has no counter at all;
 *   - `claude-session.test.ts` (in `@vendoai/apps`) doubles the SDK with a loop
 *     that yields exactly one `result` per user message it reads — which IS the
 *     counter's assumption, so the double can never disagree with it.
 *
 * So the counter's one-sidedness had no honest test anywhere. Here the session is
 * REAL and only the SDK — genuinely a third party — is a double, and it answers
 * the way `ClaudeSession.steer`'s own doc says the SDK behaves: the steered words
 * are handed to the model at its next step boundary and ride the SAME turn, so
 * the turn produces ONE result, not two.
 *
 * Against that, the count is one too high: the final `result` decrements the
 * counter instead of settling the turn, and `send()` never resolves. The counter
 * is safe in the other direction (a surplus result merely settles early, which is
 * the trap it was built for) — it is only the SHORTFALL that hangs, and
 * `createClaudeSession.interrupt` already names that hazard: "the results the
 * steers were counting on may never arrive … the caller's promise would hang to
 * the message budget". The box rung HAS that budget. This rung did not.
 */
import { describe, expect, test } from "vitest";
import { createClaudeSession } from "@vendoai/apps/claude-turn";
import { disposeLocalSessions, localMachine } from "./local.js";

/** Well under the test timeout below: a budget is the hang-detector here, not a
 *  second speed limit (see the testing note in CLAUDE.md). */
const BUDGET_MS = 500;

/**
 * An SDK that ABSORBS a mid-turn message into the turn already running.
 *
 * One `result` for the whole turn, no matter how many user messages the input
 * stream carried — the behaviour `ClaudeSession.steer` documents. The input loop
 * stays open afterwards, exactly as a live session's does, so `end()` still has
 * something to close.
 */
function absorbingSdk(prompts: string[]) {
  return {
    query: ({ prompt }: { prompt: unknown }) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "sess_absorb", model: "claude-test" };
        for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) {
          const content = message.message.content;
          prompts.push(typeof content === "string" ? content : "");
          // Only the FIRST message opens a turn. Speaking gives the harness the
          // one window a steer can land in.
          if (prompts.length > 1) continue;
          yield {
            type: "assistant",
            uuid: "asst_0",
            message: { content: [{ type: "text", text: "building it" }] },
          };
          yield {
            type: "result",
            subtype: "success",
            session_id: "sess_absorb",
            usage: { input_tokens: 10, output_tokens: 4 },
          };
        }
      },
    }),
  };
}

describe("machine: \"local\" — a steer the SDK absorbs must not hang the thread", () => {
  test("the turn ends on the budget, loudly, instead of waiting forever", async () => {
    const prompts: string[] = [];
    const threadId = `thr_local_absorb_${Math.random().toString(36).slice(2)}`;
    const machine = await localMachine({
      threadId,
      env: {},
      messageBudgetMs: BUDGET_MS,
      // The REAL session, over a doubled SDK.
      openSession: (input) => createClaudeSession({ ...input, sdk: absorbingSdk(prompts) } as never),
    });

    let steered: Promise<boolean> | undefined;
    const sending = machine.send({
      prompt: "build me a reconciliation workbench",
      // Mid-turn, from inside the SDK's own drain — the real situation.
      emit: () => { steered ??= machine.steer("group by client instead"); },
    });

    // Before the budget existed this promise stayed pending for the life of the
    // process and took the test's own timeout with it. Awaited FIRST because the
    // steer below is fired from inside the SDK's drain, a turn of the loop later.
    await expect(sending).rejects.toThrow(/budget/);
    // The words DID land: this is not a refused steer, it is a landed one whose
    // result never came.
    await expect(steered).resolves.toBe(true);
    expect(prompts).toEqual(["build me a reconciliation workbench", "group by client instead"]);

    await disposeLocalSessions();
  }, 20_000);

  test("the next turn on that thread still runs — one wedged turn is not a dead thread", async () => {
    // The queue inside `createClaudeSession` is strictly ordered, so a `send()`
    // that never settles blocks every later one behind it. Ending the turn is
    // only half the fix; the wedged session has to be DROPPED, or the thread is
    // finished for the life of the process.
    const first: string[] = [];
    const second: string[] = [];
    const threadId = `thr_local_absorb_next_${Math.random().toString(36).slice(2)}`;
    let opens = 0;
    const options = {
      threadId,
      env: {},
      messageBudgetMs: BUDGET_MS,
      openSession: (input: Record<string, unknown>) => {
        opens += 1;
        // Turn 1 gets the absorbing SDK; turn 2 gets a healthy one.
        const sdk = opens === 1 ? absorbingSdk(first) : healthySdk(second);
        return createClaudeSession({ ...input, sdk } as never);
      },
    };

    const wedging = await localMachine(options as never);
    let steered: Promise<boolean> | undefined;
    await expect(wedging.send({
      prompt: "one",
      emit: () => { steered ??= wedging.steer("and also two"); },
    })).rejects.toThrow(/budget/);
    await expect(steered).resolves.toBe(true);

    // A fresh turn, as the runtime would open it.
    const next = await localMachine(options as never);
    const events: unknown[] = [];
    await next.send({ prompt: "three", emit: (event) => events.push(event) });

    expect(second).toEqual(["three"]);
    expect(events).toContainEqual({ type: "text", delta: "re: three" });
    // The wedged session was replaced rather than reused.
    expect(opens).toBe(2);

    await disposeLocalSessions();
  }, 20_000);
});

/** One result per message, the ordinary case — nothing here is under test except
 *  that the thread is alive again. */
function healthySdk(prompts: string[]) {
  return {
    query: ({ prompt }: { prompt: unknown }) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "sess_ok", model: "claude-test" };
        for await (const message of prompt as AsyncIterable<{ message: { content: unknown } }>) {
          const content = message.message.content;
          const text = typeof content === "string" ? content : "";
          prompts.push(text);
          yield {
            type: "assistant",
            uuid: `asst_${prompts.length}`,
            message: { content: [{ type: "text", text: `re: ${text}` }] },
          };
          yield {
            type: "result",
            subtype: "success",
            session_id: "sess_ok",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        }
      },
    }),
  };
}
