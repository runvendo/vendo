import { afterEach, describe, expect, it, vi } from "vitest";
import {
  publishWorkbenchPart,
  resetWorkbench,
  subscribeWorkbench,
  workbenchFeed,
  type WorkbenchEvent,
  type WorkbenchPart,
} from "../../src/chrome/workbench-store.js";

afterEach(() => resetWorkbench());

function chunk(part: Omit<Partial<WorkbenchPart>, "event"> & { event?: unknown }, type = "data-vendo-debug") {
  return { type, data: { turnId: "thr_a", seq: 1, at: 1_000, agent: "resident", ...part } };
}

const STEP_START: WorkbenchEvent = { kind: "step-start", step: 1, maxSteps: 20, activeTools: ["find_tools"] };
const STEP_END: WorkbenchEvent = { kind: "step-end", step: 1, stopReason: "toolUse", durationMs: 940 };

describe("workbench store", () => {
  it("files a debug part under its turn and hands it back", () => {
    publishWorkbenchPart(chunk({ event: STEP_START }));
    expect(workbenchFeed()).toEqual([
      { turnId: "thr_a", parts: [{ turnId: "thr_a", seq: 1, at: 1_000, agent: "resident", event: STEP_START }] },
    ]);
  });

  it("orders a turn's parts by seq, not by arrival", () => {
    publishWorkbenchPart(chunk({ seq: 3, event: { kind: "shed", dropped: 2 } }));
    publishWorkbenchPart(chunk({ seq: 1, event: STEP_START }));
    publishWorkbenchPart(chunk({ seq: 2, agent: "subagent", event: { kind: "subagent", label: "issuer rules", steps: 7, maxSteps: 12 } }));
    expect(workbenchFeed()[0]!.parts.map(part => part.seq)).toEqual([1, 2, 3]);
  });

  it("keys by turn, keeping turns in the order their first part arrived", () => {
    publishWorkbenchPart(chunk({ turnId: "thr_b", event: STEP_START }));
    publishWorkbenchPart(chunk({ turnId: "thr_a", event: STEP_START }));
    publishWorkbenchPart(chunk({ turnId: "thr_b", seq: 2, event: STEP_END }));
    const feed = workbenchFeed();
    expect(feed.map(turn => turn.turnId)).toEqual(["thr_b", "thr_a"]);
    expect(feed[0]!.parts).toHaveLength(2);
    expect(feed[1]!.parts).toHaveLength(1);
  });

  it("ignores chunks that are not debug parts, and parts it cannot address", () => {
    publishWorkbenchPart(chunk({ event: STEP_START }, "data-vendo-status"));
    publishWorkbenchPart({ type: "data-vendo-debug", data: "not an object" });
    publishWorkbenchPart(chunk({ turnId: "", event: STEP_START }));
    publishWorkbenchPart(chunk({ seq: "1" as unknown as number, event: STEP_START }));
    publishWorkbenchPart(chunk({ agent: "operator" as WorkbenchPart["agent"], event: STEP_START }));
    publishWorkbenchPart(chunk({ event: { kind: "telepathy" } }));
    publishWorkbenchPart(chunk({}));
    expect(workbenchFeed()).toEqual([]);
  });

  it("notifies subscribers on every filed part and stops once unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWorkbench(listener);
    publishWorkbenchPart(chunk({ event: STEP_START }));
    publishWorkbenchPart(chunk({ event: STEP_START }, "data-vendo-status"));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    publishWorkbenchPart(chunk({ seq: 2, event: STEP_END }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hands back a stable snapshot until a part lands, and a fresh one after", () => {
    const before = workbenchFeed();
    expect(workbenchFeed()).toBe(before);
    publishWorkbenchPart(chunk({ event: STEP_START }));
    expect(workbenchFeed()).not.toBe(before);
  });

  it("keeps only the most recent turns, dropping the oldest first-seen", () => {
    for (let n = 1; n <= 21; n += 1) publishWorkbenchPart(chunk({ turnId: `thr_${n}`, event: STEP_START }));
    const feed = workbenchFeed();
    expect(feed).toHaveLength(20);
    expect(feed[0]!.turnId).toBe("thr_2");
    expect(feed.at(-1)!.turnId).toBe("thr_21");
  });

  it("rebuilds only the turn that changed, leaving the others' entries untouched", () => {
    publishWorkbenchPart(chunk({ turnId: "thr_a", event: STEP_START }));
    const before = workbenchFeed()[0]!;
    publishWorkbenchPart(chunk({ turnId: "thr_b", event: STEP_START }));
    publishWorkbenchPart(chunk({ turnId: "thr_b", seq: 2, event: STEP_END }));
    const after = workbenchFeed()[0]!;
    expect(after).toBe(before);
    expect(after.parts).toBe(before.parts);
  });

  it("forgets every turn on reset", () => {
    publishWorkbenchPart(chunk({ event: STEP_START }));
    resetWorkbench();
    expect(workbenchFeed()).toEqual([]);
  });
});
