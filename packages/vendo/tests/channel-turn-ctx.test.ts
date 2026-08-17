import type { RunContext } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import type { ChannelLink } from "../src/channel-links.js";
import { runChannelTurn } from "../src/channel-turn.js";

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

function turnDeps(captured: { ctx?: RunContext }) {
  return {
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
