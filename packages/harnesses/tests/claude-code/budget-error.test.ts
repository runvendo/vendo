/**
 * A turn that outran its message budget is not a broken sandbox.
 *
 * Both rungs used to answer `sandbox-unavailable` — the same code the box throws
 * when the machine refuses the session handshake (`box.ts`) or when its control
 * port answers non-200. So a turn that merely ran long (observed live: an agent
 * retry-loop burning 7.7–9.0 minutes) sent an operator to check a machine that
 * was healthy the whole time, while the real cause — the budget — was only
 * visible in the message text.
 *
 * The budget is one of `MESSAGE_BUDGET_MS`'s two rungs, and its own doc says both
 * rungs owe the caller the SAME answer, so both are covered here.
 */
import { VendoError } from "@vendoai/core";
import { afterEach, describe, expect, test } from "vitest";
import { boxMachine, type SandboxAdapterLike } from "../../src/claude-code/box.js";
import { disposeLocalSessions, localMachine } from "../../src/claude-code/local.js";

/** Well under the test timeout: the budget is the hang-detector here, not a
 *  second speed limit (see the testing note in CLAUDE.md). */
const BUDGET_MS = 300;

const encoder = new TextEncoder();

/**
 * A box that is perfectly HEALTHY and simply never finishes the message: it
 * greets, accepts the message, and then answers every poll "nothing yet". That is
 * the shape the budget exists for, and the shape whose error used to blame it.
 */
function neverFinishingBox(): SandboxAdapterLike {
  const answer = (body: unknown) => ({
    status: 200,
    headers: {},
    body: encoder.encode(JSON.stringify(body)),
  });
  const machine = {
    id: "box_budget",
    request: async (req: { path: string }) => {
      if (req.path === "/session/message") return answer({ messageId: "msg_1" });
      if (req.path.endsWith("/poll")) return answer({ events: [], done: false, cursor: 0 });
      // /session/hello and /session/<id>/interrupt
      return answer({ ok: true });
    },
    files: {
      read: async () => new Uint8Array(),
      write: async () => undefined,
      list: async () => [],
    },
    url: async () => "https://box_budget.fake-provider.test",
    destroy: async () => undefined,
  };
  return {
    create: async () => machine as never,
    destroy: async () => undefined,
  };
}

/** A live session whose turn never produces its `result` — the local twin of the
 *  box above. Nothing here is broken; the answer simply never comes. */
const neverSettlingSession = () => ({
  send: () => new Promise<void>(() => { /* never settles */ }),
  steer: () => false,
  interrupt: async () => undefined,
  end: async () => undefined,
});

/** What a rejected `send()` threw. `send()` resolves to void, so the catch's
 *  union needs narrowing before the code and message can be read. */
const rejection = async (sending: Promise<void>): Promise<VendoError> =>
  (await sending.catch((thrown: unknown) => thrown)) as VendoError;

afterEach(async () => { await disposeLocalSessions(); });

describe("a message that outruns its budget names the BUDGET, not the sandbox", () => {
  test("BOX rung: the error is not sandbox-unavailable", async () => {
    const machine = await boxMachine({
      sandbox: neverFinishingBox(),
      threadId: "thr_box_budget",
      env: {},
      allowedDomains: [],
      messageBudgetMs: BUDGET_MS,
    });

    const sending = machine.send({ prompt: "reconcile everything", emit: () => undefined });

    await expect(sending).rejects.toThrow(VendoError);
    const error = await rejection(sending);
    // The whole point: an operator triaging `sandbox-unavailable` must not find
    // this turn in the pile.
    expect(error.code).not.toBe("sandbox-unavailable");
    expect(error.code).toBe("unavailable");
    // And the message has to say which budget, or the code alone is a shrug.
    expect(error.message).toMatch(/budget/);
    expect(error.message).toContain(String(BUDGET_MS));
  }, 20_000);

  test("LOCAL rung: the same answer, because both rungs owe the same one", async () => {
    const machine = await localMachine({
      threadId: `thr_local_budget_${Math.random().toString(36).slice(2)}`,
      env: {},
      messageBudgetMs: BUDGET_MS,
      openSession: () => neverSettlingSession() as never,
    });

    const sending = machine.send({ prompt: "reconcile everything", emit: () => undefined });

    await expect(sending).rejects.toThrow(VendoError);
    const error = await rejection(sending);
    expect(error.code).not.toBe("sandbox-unavailable");
    expect(error.code).toBe("unavailable");
    expect(error.message).toMatch(/budget/);
    expect(error.message).toContain(String(BUDGET_MS));
  }, 20_000);
});
