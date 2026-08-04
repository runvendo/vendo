/**
 * M23 + M25 — what the pill and its toast may say about a turn happening
 * somewhere else. The store is the ONE source both read (run-activity.ts), so
 * these are asserted on the store itself: a parked or refused step is not the
 * live step, a refusal counts as done so the ring can settle, and the toast's
 * headline is words, not markdown.
 */
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  markRunResultsSeen,
  publishThreadRun,
  resetRunActivity,
  runActivity,
  unseenRunResult,
} from "../../src/chrome/run-activity.js";

const SURFACE = Symbol("test-thread");

type ToolState = "input-available" | "output-available" | "output-error" | "output-denied" | "approval-requested";

function turn(steps: Array<{ tool: string; state: ToolState }>, text?: string): UIMessage {
  return {
    id: "msg_a",
    role: "assistant",
    parts: [
      ...steps.map((step, index) => ({
        type: `tool-${step.tool}`,
        toolCallId: `call_${index}`,
        state: step.state,
        input: {},
        ...(step.state === "output-available" ? { output: { ok: true } } : {}),
        ...(step.state === "approval-requested" ? { approval: { id: `apr_${index}` } } : {}),
      })),
      ...(text === undefined ? [] : [{ type: "text" as const, text, state: "done" as const }]),
    ],
  } as UIMessage;
}

beforeEach(() => resetRunActivity());
afterEach(() => resetRunActivity());

describe("the pill never narrates a step that is not running (M23)", () => {
  it("does not name a PARKED ask as the live step — its card is the record", () => {
    publishThreadRun(SURFACE, {
      threadId: "thr_1",
      status: "streaming",
      messages: [turn([{ tool: "host_transferMoney", state: "approval-requested" }])],
    });
    expect(runActivity().tool).toBeUndefined();
  });

  it("does not name a REFUSED step either, and counts it as done", () => {
    publishThreadRun(SURFACE, {
      threadId: "thr_1",
      status: "streaming",
      messages: [turn([
        { tool: "host_list_transactions", state: "output-available" },
        { tool: "host_transferMoney", state: "output-denied" },
      ])],
    });
    const activity = runActivity();
    expect(activity.tool).toBeUndefined();
    // The determinate ring can reach its total: `done` used to stall at 1 of 2
    // for the rest of the turn because a denial counted as neither.
    expect([activity.done, activity.total]).toEqual([2, 2]);
  });

  it("still names a genuinely running step", () => {
    publishThreadRun(SURFACE, {
      threadId: "thr_1",
      status: "streaming",
      messages: [turn([
        { tool: "host_transferMoney", state: "output-denied" },
        { tool: "host_list_transactions", state: "input-available" },
      ])],
    });
    expect(runActivity().tool).toBe("host_list_transactions");
    expect(runActivity().done).toBe(1);
  });
});

describe("the toast headline is words, not markdown (M25)", () => {
  const settle = (text: string): string | undefined => {
    resetRunActivity();
    publishThreadRun(SURFACE, {
      threadId: "thr_1",
      status: "streaming",
      messages: [turn([{ tool: "host_list_transactions", state: "input-available" }])],
    });
    publishThreadRun(SURFACE, {
      threadId: "thr_1",
      status: "ready",
      messages: [turn([{ tool: "host_list_transactions", state: "output-available" }], text)],
    });
    const headline = unseenRunResult()?.headline;
    markRunResultsSeen();
    return headline;
  };

  it("strips a heading, a bullet and a blockquote", () => {
    expect(settle("### July spending\n\nHere it is.")).toBe("July spending");
    expect(settle("- Sent your July statement")).toBe("Sent your July statement");
    expect(settle("> Nothing was changed")).toBe("Nothing was changed");
  });

  it("strips inline emphasis, code marks and a link's target", () => {
    expect(settle("**Done** — see the `spending` view")).toBe("Done — see the spending view");
    expect(settle("Opened [your dashboard](https://app.test/x) for you"))
      .toBe("Opened your dashboard for you");
  });

  it("leaves ordinary prose alone", () => {
    expect(settle("I moved $47.50 to Acme Utilities.")).toBe("I moved $47.50 to Acme Utilities.");
  });
});

/** Round B's dual-surface finding: a host may mount BOTH VendoOverlay and
 *  VendoPage on one conversation. Each hook publishes its own snapshot, so one
 *  finished turn used to raise two completion toasts. */
describe("one turn, one announcement (dual-surface dedupe)", () => {
  const OTHER = Symbol("second-thread-surface");

  const running = { threadId: "thr_1", status: "streaming" as const, messages: [turn([{ tool: "host_list_transactions", state: "input-available" }])] };
  const ready = { threadId: "thr_1", status: "ready" as const, messages: [turn([{ tool: "host_list_transactions", state: "output-available" }], "All done.")] };

  it("announces once when two surfaces both settle the same turn", () => {
    publishThreadRun(SURFACE, running);
    publishThreadRun(OTHER, running);
    publishThreadRun(SURFACE, ready);
    const first = unseenRunResult();
    expect(first?.headline).toBe("All done.");
    publishThreadRun(OTHER, ready);
    // The SAME result object, not a second one with a bumped id.
    expect(unseenRunResult()?.id).toBe(first?.id);
  });

  it("still announces the NEXT turn in the same conversation", () => {
    publishThreadRun(SURFACE, running);
    publishThreadRun(SURFACE, ready);
    const first = unseenRunResult()!;
    markRunResultsSeen();
    const secondTurn = {
      threadId: "thr_1",
      status: "ready" as const,
      messages: [{ ...turn([{ tool: "host_list_transactions", state: "output-available" }], "And again."), id: "msg_b" } as UIMessage],
    };
    publishThreadRun(SURFACE, running);
    publishThreadRun(SURFACE, secondTurn);
    expect(unseenRunResult()?.headline).toBe("And again.");
    expect(unseenRunResult()?.id).not.toBe(first.id);
  });
});
