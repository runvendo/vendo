import { describe, it, expect, beforeEach, vi } from "vitest";
import { runPoll, resetPoller } from "./poller";
import { addRule, clearRules } from "./rules-store";
import { placeOrder } from "@/server/orders";
import type { SlackFireResult } from "./slack";

const okPoster = vi.fn(
  async (channel: string, text: string): Promise<SlackFireResult> => ({
    ok: true,
    fallback: false,
    channel,
    text,
  }),
);

beforeEach(() => {
  clearRules();
  resetPoller();
  okPoster.mockClear();
});

describe("runPoll", () => {
  it("baselines existing transactions so the planted charge never fires", async () => {
    addRule({
      description: "late-night delivery",
      trigger: { lateNightOnly: true, categories: ["dining"], keywords: ["doordash", "delivery"] },
    });
    // First poll: baseline. The seeded $87 DoorDash charge matches the rule but
    // must NOT fire because it predates the watcher.
    const first = await runPoll(okPoster);
    expect(first).toHaveLength(0);
    expect(okPoster).not.toHaveBeenCalled();
  });

  it("fires once on a new late-night order placed after baseline", async () => {
    addRule({
      description: "late-night delivery",
      channel: "general",
      trigger: { lateNightOnly: true, categories: ["dining"], keywords: ["doordash", "delivery"] },
    });
    await runPoll(okPoster); // baseline
    placeOrder(); // new late-night DoorDash order

    const fired = await runPoll(okPoster);
    expect(fired).toHaveLength(1);
    expect(fired[0].channel).toBe("general");
    expect(fired[0].slack.ok).toBe(true);
    expect(okPoster).toHaveBeenCalledTimes(1);

    // Idempotent: a subsequent poll with no new order fires nothing.
    const again = await runPoll(okPoster);
    expect(again).toHaveLength(0);
    expect(okPoster).toHaveBeenCalledTimes(1);
  });

  it("does not fire when no rule is active", async () => {
    await runPoll(okPoster); // baseline
    placeOrder();
    const fired = await runPoll(okPoster);
    expect(fired).toHaveLength(0);
  });
});
