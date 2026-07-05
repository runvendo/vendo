import { describe, expect, it } from "vitest";
import { createToastQueue, toastKey } from "./toast-queue";

const completed = (runId: string) => ({
  kind: "completed" as const,
  runId,
  summary: `run ${runId}`,
  text: `Automation finished (${runId}).`,
});

const approval = (runId: string, stepId: string) => ({
  kind: "approval-required" as const,
  runId,
  stepId,
  summary: "wants to send",
  text: "Needs approval.",
});

describe("createToastQueue", () => {
  it("shows max 2 with FIFO backfill on dismiss", () => {
    const queue = createToastQueue();
    for (const id of ["r1", "r2", "r3", "r4"]) queue.push(completed(id));
    expect(queue.visible().map((t) => t.runId)).toEqual(["r1", "r2"]);
    queue.dismiss(toastKey(completed("r1")));
    expect(queue.visible().map((t) => t.runId)).toEqual(["r2", "r3"]);
  });

  it("dedupes by (kind, runId, stepId)", () => {
    const queue = createToastQueue();
    queue.push(completed("r1"));
    queue.push(completed("r1"));
    queue.push(approval("r1", "s1"));
    queue.push(approval("r1", "s1"));
    expect(queue.visible()).toHaveLength(2);
  });

  it("suppression hides without dropping; release restores", () => {
    const queue = createToastQueue();
    queue.push(completed("r1"));
    queue.setSuppressed(true);
    expect(queue.visible()).toEqual([]);
    queue.push(completed("r2")); // arrives mid-conversation
    queue.setSuppressed(false);
    expect(queue.visible().map((t) => t.runId)).toEqual(["r1", "r2"]);
  });

  it("approvals are persistent; completions are not", () => {
    const queue = createToastQueue();
    queue.push(completed("r1"));
    queue.push(approval("r2", "s1"));
    const [done, ask] = queue.visible();
    expect(done!.persistent).toBe(false);
    expect(ask!.persistent).toBe(true);
  });

  it("state transitions notify subscribers and stale approvals stop persisting", () => {
    const queue = createToastQueue();
    let notified = 0;
    queue.subscribe(() => notified++);
    queue.push(approval("r1", "s1"));
    const key = toastKey(approval("r1", "s1"));
    queue.setState(key, "stale");
    expect(queue.visible()[0]!.state).toBe("stale");
    expect(queue.visible()[0]!.persistent).toBe(false);
    expect(notified).toBeGreaterThanOrEqual(2);
  });
});
