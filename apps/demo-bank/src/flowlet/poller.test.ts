/**
 * The poller is now a pure EVENT ADAPTER: it diffs Maple's existing
 * transactions API and emits `transaction.created` into the automations world
 * (true to "we didn't touch the bank"). Matching, messaging, and Slack are the
 * automation's job — created here through the real authoring tool.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Tool, ToolCallOptions } from "ai";
import { runPoll, resetPoller } from "./poller";
import { createAutomationsWorld } from "./automations";
import type { SlackFireResult } from "./slack";
import { placeOrder } from "@/server/orders";
import { __reseed } from "@/server/store";

const CALL_OPTS = { toolCallId: "tc", messages: [] } as unknown as ToolCallOptions;

const okPoster = vi.fn(
  async (channel: string, text: string): Promise<SlackFireResult> => ({
    ok: true,
    fallback: false,
    channel,
    text,
  }),
);

async function worldWithSnitch() {
  const world = createAutomationsWorld({ poster: okPoster });
  const create = world.authoringTools()["create_automation"] as Tool;
  const result = (await create.execute!(
    {
      spec: {
        dslVersion: 1,
        name: "Late-night delivery snitch",
        description: "Post to #general on late-night delivery",
        prompt: "snitch on me",
        trigger: { type: "host_event", event: "transaction.created" },
        if: "trigger.direction = 'debit' and trigger.hour < 5 and trigger.category = 'dining'",
        execution: {
          mode: "steps",
          steps: [
            {
              id: "snitch",
              type: "tool",
              tool: "SLACK_SEND_MESSAGE",
              input: { channel: "#general", text: "{{ trigger.merchant }} at {{ trigger.time }}" },
            },
          ],
        },
      },
      grantedTools: ["SLACK_SEND_MESSAGE"],
    } as never,
    CALL_OPTS,
  )) as { ok: boolean };
  expect(result.ok).toBe(true);
  return world;
}

beforeEach(() => {
  __reseed(new Date("2026-06-29T12:00:00-07:00"));
  resetPoller();
  okPoster.mockClear();
});

describe("runPoll (event adapter)", () => {
  it("baselines existing transactions so the planted charge never fires", async () => {
    const world = await worldWithSnitch();
    const first = await runPoll(world);
    expect(first).toHaveLength(0);
    expect(okPoster).not.toHaveBeenCalled();
  });

  it("fires once on a new late-night order placed after baseline, idempotently", async () => {
    const world = await worldWithSnitch();
    await runPoll(world); // baseline
    placeOrder();

    const fired = await runPoll(world);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.channel).toBe("#general");
    expect(fired[0]!.slack.ok).toBe(true);
    expect(okPoster).toHaveBeenCalledTimes(1);

    const again = await runPoll(world);
    expect(again).toHaveLength(0);
    expect(okPoster).toHaveBeenCalledTimes(1);
  });

  it("emits nothing when no automation is active", async () => {
    const world = createAutomationsWorld({ poster: okPoster });
    await runPoll(world); // baseline
    placeOrder();
    const fired = await runPoll(world);
    expect(fired).toHaveLength(0);
    expect(okPoster).not.toHaveBeenCalled();
  });
});
