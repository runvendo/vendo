/**
 * WHAT A TEXTED REPLY IS ALLOWED TO WAIT FOR.
 *
 * Two calls used to stand between an inbound text and the first word on the
 * person's phone, and neither one is something the answer depends on: the host's
 * memberships seam, asked before anything else the turn does, and the link write
 * that remembers which thread this conversation is running in — a network call
 * on a hosted store.
 *
 * They are still guaranteed, just no longer in front of the answer, and the
 * guarantees are what these cases pin. The link write has two readers and the
 * order below is theirs: `vendo_text_me` reads the CONVERSATION off the same row
 * mid-turn (text-me.ts) and nothing else writes it, so a first-ever turn still
 * waits; the next text on this conversation reads the THREAD it names, and the
 * per-conversation queue (compose-channels.ts) cannot start that turn until this
 * one's promise settles — so the write is awaited before the turn returns,
 * behind the reply instead of in front of it.
 *
 * Nothing here asserts on wall-clock time: the write settles a few event-loop
 * turns late and the cases read the ORDER it settled in, so what they prove is
 * decided by the code and never by how busy the machine is.
 */
import { THREAD_ID_HEADER } from "@vendoai/harnesses";
import { describe, expect, it } from "vitest";
import type { ChannelLink } from "../src/channel-links.js";
import { runChannelTurn } from "../src/channel-turn.js";

const link: ChannelLink = {
  id: "chl_hot",
  subject: "user_hot",
  phone: "+15551230123",
  linkedAt: "2026-08-19T10:22:10.710Z",
};

const event = {
  eventId: "evt_hot",
  channel: "text" as const,
  from: "+15551230123",
  text: "what did I spend on food last month?",
  conversationId: "conv_hot",
  receivedAt: "2026-08-19T10:22:11.211Z",
};

/** A link write that lands a few event-loop turns late — long enough for a reply
 *  that does not wait for it to get ahead of it, and short enough that one which
 *  does wait still finishes. */
const slowWrite = (order: string[]) => async (): Promise<void> => {
  for (let hop = 0; hop < 5; hop += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  order.push("wrote");
};

function turnDeps(order: string[], overrides: Record<string, unknown> = {}) {
  return {
    harness: {
      stream: async () => new Response("data: {\"type\":\"text-delta\",\"delta\":\"ok\"}\n\n", {
        headers: { "content-type": "text/event-stream", [THREAD_ID_HEADER]: "thr_hot" },
      }),
    },
    guard: {
      onApprovalRequested: () => () => undefined,
      approvals: { pending: async () => [], decide: async () => undefined },
    },
    channel: { send: async () => { order.push("sent"); } },
    links: { rememberTurn: slowWrite(order) },
    asks: {
      ids: async () => [],
      add: async () => undefined,
      consume: async () => undefined,
      setAsk: async () => null,
      consumeSet: async () => undefined,
    },
    ...overrides,
  } as unknown as Parameters<typeof runChannelTurn>[0];
}

describe("what a texted reply waits for", () => {
  it("answers while the link write is still in flight, and still lands it before the turn ends", async () => {
    const order: string[] = [];
    // The write is HELD until the reply is out, so a turn that still waits for it
    // never sends anything at all and the case's own timeout says so. The row
    // already names this conversation, which is exactly when overlapping is safe:
    // the one reader a tool could reach mid-turn already has its answer.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const deps = turnDeps(order, {
      channel: { send: async () => { order.push("sent"); release(); } },
      links: { rememberTurn: async () => { await held; order.push("wrote"); } },
    });

    await runChannelTurn(deps, { event, link: { ...link, conversationId: event.conversationId } });

    expect(order).toEqual(["sent", "wrote"]);
  });

  it("claims the deferred write's rejection while it is still deferred, and surfaces it after the reply", async () => {
    // THE POINT: a promise nobody is awaiting YET is a promise Node considers
    // unhandled. The reply takes as long as the model does, so a hosted link
    // store that refuses the write early leaves the rejection unclaimed for that
    // whole window — and Node's default throw-mode kills the host process there,
    // before the person holding the phone gets a single word.
    const order: string[] = [];
    const unhandled: unknown[] = [];
    const watch = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", watch);
    try {
      const deps = turnDeps(order, {
        // The refusal lands FIRST; the reply is still going out for another
        // 20ms, which is the window the claim has to cover.
        links: { rememberTurn: async () => { throw new Error("link store is down"); } },
        channel: {
          send: async () => {
            order.push("sent");
            await new Promise((resolve) => setTimeout(resolve, 20));
          },
        },
      });

      await expect(runChannelTurn(deps, { event, link: { ...link, conversationId: event.conversationId } }))
        .rejects.toThrow("link store is down");

      // Claimed, never swallowed: the reply went out first and the failure still
      // reaches the caller at the await below it.
      expect(unhandled).toEqual([]);
      expect(order).toEqual(["sent"]);
    } finally {
      process.off("unhandledRejection", watch);
    }
  });

  it("reads the approval feed BESIDE the link write, not behind it", async () => {
    // THE POINT: both of these sit between the reply landing and the queue being
    // released (compose-channels.ts), and they have nothing to say to each other
    // — one is this conversation's row, the other is the subject's approval feed.
    // Run end to end they cost a queued next text two hosted round trips of pure
    // bookkeeping before its own turn can start.
    //
    // The write is held until the feed has been ASKED, so a turn that still reads
    // them one after the other never finishes and the case's own timeout says so.
    const order: string[] = [];
    let asked = (): void => undefined;
    const feedAsked = new Promise<void>((resolve) => { asked = resolve; });
    const deps = turnDeps(order, {
      links: { rememberTurn: async () => { await feedAsked; order.push("wrote"); } },
      guard: {
        onApprovalRequested: () => () => undefined,
        approvals: {
          pending: async () => { order.push("asked-feed"); asked(); return []; },
          decide: async () => undefined,
        },
      },
    });

    await runChannelTurn(deps, { event, link: { ...link, conversationId: event.conversationId } });

    // The reply first, then the two bookkeeping calls overlapping — the feed read
    // starts while the write is still outstanding.
    expect(order).toEqual(["sent", "asked-feed", "wrote"]);
  });

  it("waits for the write on the first turn a phone ever sends, so Text me can find the conversation", async () => {
    const order: string[] = [];

    // No conversation on the row yet. `vendo_text_me` would be told there is no
    // phone to reach, on the one turn where the person is definitely holding it.
    await runChannelTurn(turnDeps(order), { event, link });

    expect(order).toEqual(["wrote", "sent"]);
  });

  it("settles a grant-set answer without waiting on the host's memberships call", async () => {
    const order: string[] = [];
    const sent: string[] = [];
    // A host whose seam never answers. The set decision needs no ctx at all, so
    // it must not be queued behind a round trip taken for one.
    const deps = turnDeps(order, {
      memberships: () => new Promise<never>(() => undefined),
      channel: { send: async (input: { text: string }) => { sent.push(input.text); } },
      guard: {
        onApprovalRequested: () => () => undefined,
        approvals: { pending: async () => [{ id: "apr_set" }], decide: async () => undefined },
      },
      asks: {
        ids: async () => [],
        add: async () => undefined,
        consume: async () => undefined,
        setAsk: async () => ({ automationId: "atm_hot", approvals: ["apr_set"] }),
        consumeSet: async () => undefined,
      },
    });

    await runChannelTurn(deps, { event: { ...event, text: "YES" }, link });

    expect(sent).toEqual(["Done — it can run on its own now."]);
  });
});
