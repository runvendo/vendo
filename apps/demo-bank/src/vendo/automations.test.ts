/**
 * Embedded automations world: end-to-end demo parity. The Slack snitch is pure
 * data — created through the authoring tool, fired by a transaction event,
 * posting through the (stubbed) Slack poster, surfacing a toast event.
 */
import { describe, expect, it, vi } from "vitest";
import type { Tool, ToolCallOptions } from "ai";
import { createAutomationsWorld } from "./automations";
import type { SlackFireResult } from "./slack";
import { placeOrder } from "@/server/orders";
import { __reseed } from "@/server/store";

const CALL_OPTS = { toolCallId: "tc", messages: [] } as unknown as ToolCallOptions;

function okPoster() {
  return vi.fn(
    async (channel: string, text: string): Promise<SlackFireResult> => ({
      ok: true,
      fallback: false,
      channel,
      text,
    }),
  );
}

/** The snitch spec exactly as the compiler would emit it (doc example 1). */
function snitchSpec() {
  return {
    dslVersion: 1,
    name: "Late-night delivery snitch",
    description: "Post to #general when a late-night food delivery charge posts",
    prompt: "snitch on me in #general if I order food delivery late at night",
    trigger: { type: "host_event", event: "transaction.created" },
    if: "trigger.direction = 'debit' and trigger.hour >= 0 and trigger.hour < 5 and trigger.category = 'dining' and ($contains($lowercase(trigger.merchant & ' ' & trigger.descriptor), 'delivery') or $contains($lowercase(trigger.merchant), 'doordash') or $contains($lowercase(trigger.merchant), 'grubhub') or $contains($lowercase(trigger.merchant), 'uber eats'))",
    execution: {
      mode: "steps",
      steps: [
        {
          id: "snitch",
          type: "tool",
          tool: "SLACK_SEND_MESSAGE",
          input: {
            channel: "#general",
            text: "Late-night delivery alert: {{ user.name }} just ordered *{{ trigger.merchant }}* (${{ trigger.amountDollars }}) at {{ trigger.time }}. He set up this alert to snitch on himself. Someone stage an intervention.",
          },
        },
      ],
    },
  };
}

async function createSnitch(
  world: ReturnType<typeof createAutomationsWorld>,
  opts: { granted?: boolean } = {},
) {
  const tools = world.authoringTools();
  const create = tools["create_automation"] as Tool;
  const result = (await create.execute!(
    {
      spec: snitchSpec(),
      grantedTools: opts.granted === false ? [] : ["SLACK_SEND_MESSAGE"],
    } as never,
    CALL_OPTS,
  )) as { ok: boolean; errors?: string[]; automation?: { id: string } };
  expect(result.ok, String(result.errors)).toBe(true);
  return result.automation!.id;
}

describe("demo automations world", () => {
  it("snitch-as-data: transaction event -> guard -> real interpolated Slack post -> toast event", async () => {
    __reseed(new Date("2026-06-29T12:00:00-07:00"));
    const poster = okPoster();
    const world = createAutomationsWorld({ poster });
    await createSnitch(world);

    const txn = placeOrder(); // the planted late-night DoorDash order
    await world.emitTransaction(txn);

    expect(poster).toHaveBeenCalledTimes(1);
    const [channel, text] = poster.mock.calls[0]!;
    expect(channel).toBe("#general");
    expect(text).toContain("DoorDash");
    expect(text).toMatch(/\$\d/);

    const events = world.drainFireEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      txnId: txn.id,
      merchant: txn.merchant,
      channel: "general", // no leading # — the toast renders "#{channel}"
      slack: { ok: true, fallback: false },
    });
    expect(world.drainFireEvents()).toHaveLength(0); // drained
  });

  it("emits nothing for a guard-false transaction (compact skipped run)", async () => {
    __reseed(new Date("2026-06-29T12:00:00-07:00"));
    const poster = okPoster();
    const world = createAutomationsWorld({ poster });
    const id = await createSnitch(world);

    const txn = placeOrder({ hour: 14 }); // daytime — guard false
    await world.emitTransaction(txn);

    expect(poster).not.toHaveBeenCalled();
    expect(world.drainFireEvents()).toHaveLength(0);
    const runs = await world.store.listRuns(world.scope, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("skipped");
  });

  it("without the grant, the gated post pauses as waiting_approval instead of firing", async () => {
    __reseed(new Date("2026-06-29T12:00:00-07:00"));
    const poster = okPoster();
    const world = createAutomationsWorld({ poster });
    const id = await createSnitch(world, { granted: false });

    const txn = placeOrder();
    await world.emitTransaction(txn);

    expect(poster).not.toHaveBeenCalled();
    const runs = await world.store.listRuns(world.scope, id);
    expect(runs[0]!.outcome).toBe("waiting_approval");
    expect(world.drainFireEvents()).toHaveLength(0);
  });

  it("duplicate transaction events never double-post", async () => {
    __reseed(new Date("2026-06-29T12:00:00-07:00"));
    const poster = okPoster();
    const world = createAutomationsWorld({ poster });
    await createSnitch(world);

    const txn = placeOrder();
    await world.emitTransaction(txn);
    await world.emitTransaction(txn);
    expect(poster).toHaveBeenCalledTimes(1);
  });
});
