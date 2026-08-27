/**
 * The SEAM: what a box turn that outran its budget is finally CALLED.
 *
 * `@vendoai/harnesses` throws the budget error and `@vendoai/apps` turns a throw
 * into the sentence on the person's failure card — and apps cannot import
 * harnesses, so the two only meet in the umbrella. They disagreed silently for
 * exactly that reason: the budget throw carries code `unavailable`, which the
 * mapper read as a busy service, so four escalated builds on 2026-08-27 died at
 * 15.2–15.4 minutes and every one of them told the person "busy, try again
 * shortly". Deterministic exhaustion, reported as transient capacity — which is
 * an invitation to retry, and the lane retried three more times.
 *
 * Nothing is stubbed on either side: the REAL box poll loop runs out its REAL
 * deadline, and the REAL classifier reads the throw it really produced. A test
 * that asserted the sentence against a hand-written VendoError would have passed
 * on the broken code, because the hand-written one is where the bug was.
 */
import { VendoError } from "@vendoai/core";
import { buildFailureReason } from "@vendoai/apps";
import {
  boxMachine,
  disposeSessionMachines,
  type SandboxAdapterLike,
} from "@vendoai/harnesses/claude-code";
import { afterEach, describe, expect, it } from "vitest";

/** Well under the test timeout: the budget is the hang-detector here, not a
 *  second speed limit (see the testing note in CLAUDE.md). */
const BUDGET_MS = 300;

const encoder = new TextEncoder();

/** A box that is perfectly HEALTHY and simply never finishes the message — it
 *  greets, takes the message, and answers every poll "nothing yet". That is the
 *  shape a build budget exists for, and the shape whose reason was wrong. */
const neverFinishingBox = (): SandboxAdapterLike => {
  const answer = (body: unknown) => ({
    status: 200,
    headers: {},
    body: encoder.encode(JSON.stringify(body)),
  });
  const machine = {
    id: "box_build_budget",
    request: async (req: { path: string }) => {
      if (req.path === "/session/message") return answer({ messageId: "msg_1" });
      if (req.path.endsWith("/poll")) return answer({ events: [], done: false, cursor: 0 });
      return answer({ ok: true });
    },
    files: { read: async () => new Uint8Array(), write: async () => undefined, list: async () => [] },
    url: async () => "https://box_build_budget.fake-provider.test",
    destroy: async () => undefined,
  };
  return { create: async () => machine as never, destroy: async () => undefined };
};

afterEach(async () => { await disposeSessionMachines(); });

describe("a build that outran its budget is not told it is a busy service", () => {
  it("says the time budget ran out, and does not invite a retry", async () => {
    const machine = await boxMachine({
      sandbox: neverFinishingBox(),
      threadId: "thr_build_budget",
      env: {},
      allowedDomains: [],
      messageBudgetMs: BUDGET_MS,
    });

    const thrown = await machine
      .send({ prompt: "build this for real", emit: () => undefined })
      .then(() => undefined, (error: unknown) => error);

    // The real throw, not one this test wrote.
    expect(thrown).toBeInstanceOf(VendoError);
    expect((thrown as VendoError).code).toBe("unavailable");

    const { reason, retryable } = buildFailureReason(thrown);
    expect(reason).toBe("the build ran out of its time budget");
    // The mislabel itself: `unavailable` used to mean capacity and nothing else.
    expect(reason).not.toBe("busy, try again shortly");
    // A budget expires on schedule, so waiting cannot help — and `retryable`
    // is what tells the calling agent "asking for it again may work"
    // (@vendoai/mcp door.ts).
    expect(retryable).toBe(false);
  }, 20_000);
});
