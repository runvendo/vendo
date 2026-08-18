import type { RunContext } from "@vendoai/core";
import { memoryStoreOps } from "@vendoai/core/conformance";
import { describe, expect, it, vi } from "vitest";
import type { ChannelLink } from "../src/channel-links.js";
import { cronProse, runChannelTurn, type ChannelTurnDeps } from "../src/channel-turn.js";
import { createLimiter } from "../src/limits.js";

describe("cronProse", () => {
  it("words the shapes an agent actually mints, beside the raw value", () => {
    expect(cronProse("*/15 * * * *")).toBe("every 15 minutes");
    expect(cronProse("* * * * *")).toBe("every minute");
    expect(cronProse("0 * * * *")).toBe("every hour");
    expect(cronProse("30 * * * *")).toBe("every hour at :30");
    expect(cronProse("0 */6 * * *")).toBe("every 6 hours");
    expect(cronProse("30 9 * * *")).toBe("daily at 9:30");
    expect(cronProse("0 8 * * 1")).toBe("every Monday at 8:00");
  });
  it("stays silent on anything it cannot word honestly", () => {
    expect(cronProse("0 9 1 * *")).toBeUndefined(); // monthly — not covered
    expect(cronProse("0 9 * 2 *")).toBeUndefined(); // month-bound
    expect(cronProse("1,31 * * * *")).toBeUndefined(); // lists
    expect(cronProse("not a cron")).toBeUndefined();
    expect(cronProse("check my balance")).toBeUndefined();
  });
});

/**
 * WHAT A TEXTED TURN TELLS THE REST OF THE SYSTEM ABOUT ITSELF.
 *
 * The ctx a channel turn builds is not bookkeeping: it decides how the turn's
 * HOST calls authenticate. `presence: "present"` is true and load-bearing — a
 * person is holding their phone, which is what lets the guard ask them to
 * approve a payment rather than refusing it outright — but present also means
 * "forward the caller's request credentials", and a text message has no request
 * behind it.
 *
 * A linked customer texted "what did I spend on food last month?" and got an
 * apology about a sign-in problem: the tool call had reached the host API with
 * no credentials at all. `channelLink` is what routes it through the ActAs seam
 * instead, so these cases pin that the turn actually carries it.
 */

const link: ChannelLink = {
  id: "chl_1",
  subject: "vendo-demo",
  phone: "+15551230123",
  linkedAt: "2026-08-17T10:22:10.710Z",
};

const event = {
  eventId: "evt_1",
  channel: "text" as const,
  from: "+15551230123",
  text: "what did I spend on food last month?",
  conversationId: "conv_1",
  receivedAt: "2026-08-17T10:22:11.211Z",
};

function turnDeps(captured: { ctx?: RunContext }, memberships?: ChannelTurnDeps["memberships"]) {
  return {
    memberships,
    harness: {
      stream: vi.fn(async (input: { ctx: RunContext }) => {
        captured.ctx = input.ctx;
        return new Response("data: {\"type\":\"text-delta\",\"delta\":\"ok\"}\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    },
    guard: {
      onApprovalRequested: () => () => undefined,
      approvals: { pending: async () => [], decide: async () => undefined },
    },
    channel: { send: vi.fn(async () => undefined) },
    links: { rememberTurn: vi.fn(async () => undefined) },
    asks: { ids: async () => [], add: vi.fn(async () => undefined), consume: vi.fn(async () => undefined) },
  } as unknown as Parameters<typeof runChannelTurn>[0];
}

describe("the ctx a texted turn runs under", () => {
  it("carries the link, so host calls authenticate through actAs", async () => {
    const captured: { ctx?: RunContext } = {};

    await runChannelTurn(turnDeps(captured), { event, link });

    expect(captured.ctx?.channelLink).toEqual({
      channel: "text",
      linkedAt: "2026-08-17T10:22:10.710Z",
    });
  });

  it("keeps presence present, because somebody is holding the phone", async () => {
    // Both halves matter and they pull in different directions: presence is what
    // lets the guard ASK for approval instead of refusing, and the link is what
    // authenticates the call it asked about. Losing either one breaks the
    // feature in a way the other cannot cover.
    const captured: { ctx?: RunContext } = {};

    await runChannelTurn(turnDeps(captured), { event, link });

    expect(captured.ctx).toMatchObject({
      venue: "chat",
      presence: "present",
      principal: { kind: "user", subject: "vendo-demo" },
      sessionId: "evt_1",
    });
  });

  it("asks the memberships seam for the linked subject, so the org's allowance is spent and debited", async () => {
    // The org pool is DERIVED from the ctx's memberships (limits.ts), so a texted
    // turn that never asked the seam is silently outside every org cap: it does
    // not count against the allowance and does not accrue to it. The real limiter
    // over a real meter is what says otherwise.
    const captured: { ctx?: RunContext } = {};
    const usage = memoryStoreOps().usage!;
    const limiter = createLimiter({ callback: () => true, ops: usage });

    await runChannelTurn(turnDeps(captured, async () => [{ org: "maple" }]), { event, link });
    await limiter.gate("message", captured.ctx!);

    expect(captured.ctx?.memberships).toEqual([{ org: "maple" }]);
    expect(await usage.count({ action: "message", poolKey: "org:maple", since: new Date(0) })).toBe(1);
  });

  it("stamps a link that never recorded its time, rather than omitting the evidence", async () => {
    // `linkedAt` is optional on the row. A link with none is still a link, and
    // dropping the field would silently put the turn back on the present path.
    const captured: { ctx?: RunContext } = {};
    const { linkedAt: _none, ...undated } = link;

    await runChannelTurn(turnDeps(captured), { event, link: undated });

    expect(captured.ctx?.channelLink?.channel).toBe("text");
    expect(captured.ctx?.channelLink?.linkedAt).toEqual(expect.any(String));
  });
});
