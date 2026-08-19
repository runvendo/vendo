import type { RunContext } from "@vendoai/core";
import { memoryStoreOps } from "@vendoai/core/conformance";
import { describe, expect, it, vi } from "vitest";
import type { ChannelLink } from "../src/channel-links.js";
import { bubbles, cronProse, runChannelTurn, type ChannelTurnDeps } from "../src/channel-turn.js";
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

describe("bubbles", () => {
  const six = (separator: string) => [
    "Checking is at $412.08 right now and nothing is pending on it.",
    "Savings is sitting at $8,200.00.",
    "The joint account with Dana has $1,140.55 in it.",
    "Your credit card balance is -$318.20.",
    "The travel card is at -$64.00.",
    "The emergency fund is untouched at $15,000.00.",
  ].join(separator);

  it("cuts a wall at the boundary a person would have used, and puts every word back", () => {
    // The three rungs, on the same six-account listing the live turns produced.
    for (const [label, separator] of [["blank line", "\n\n"], ["line end", "\n"], ["sentence", " "]] as const) {
      const wall = six(separator);
      const pieces = bubbles(wall);
      expect(pieces.length, label).toBeGreaterThan(1);
      expect(pieces.length, label).toBeLessThanOrEqual(3);
      // Nothing invented, dropped or reordered.
      expect(pieces.join(separator), label).toBe(wall);
      // And no piece stops mid-thought.
      for (const piece of pieces) expect(piece, label).toMatch(/[.!?]$/);
    }
  });

  it("cuts a formatted reply without reformatting it", () => {
    // A reply the model laid out itself — against TEXT_STYLE's "no lists", which
    // it ignores as readily as it ignores the divider. Cutting it is fine; RE-
    // INDENTING it is not, and trimming each line did exactly that.
    const laid = [
      "Here is where everything stands this morning:",
      "  Checking — $412.08, nothing pending on it",
      "  Savings — $8,200.00, up $50 since last month",
      "  Joint with Dana — $1,140.55",
      "  Credit card — -$318.20, due on the 14th",
      "  Travel card — -$64.00",
      "  Emergency fund — $15,000.00, untouched",
    ].join("\n");
    const pieces = bubbles(laid);

    expect(pieces.length).toBeGreaterThan(1);
    // Byte for byte what the model wrote, only cut — indentation included.
    expect(pieces.join("\n")).toBe(laid);
  });

  it("rebuilds a piece from the model's own separators, not canonical ones", () => {
    // The other half of not reformatting: the bytes BETWEEN the parts of one
    // bubble are the model's too. A blank line that carries spaces and a double
    // space after a full stop both used to be rewritten to a canonical separator.
    const spaced = "Everything is settled for the month, and nothing else needs a decision from you today.   \n"
      + "  \nChecking sits at $412.08 and savings at $8,200.00, which is up fifty dollars.   \n"
      + "  \nThe travel card is the only one still carrying a balance, at -$64.00 as of tonight.";
    const pieces = bubbles(spaced);

    expect(pieces.length).toBeGreaterThan(1);
    // Every piece is the model's own bytes, in order, and the only thing dropped
    // between two of them is the whitespace boundary that was the cut point. A
    // piece rebuilt with a canonical separator would not be a substring at all.
    let at = 0;
    for (const piece of pieces) {
      const found = spaced.indexOf(piece, at);
      expect(found, piece).toBeGreaterThanOrEqual(at);
      expect(spaced.slice(at, found)).toMatch(/^\s*$/);
      at = found + piece.length;
    }
    expect(at).toBe(spaced.length);
  });

  it("does not mistake an abbreviation for the end of a sentence", () => {
    // Both shapes a bank reply actually produces. "acc. 1234" is followed by a
    // digit and "Dr. Smith" by a title, and a cut after either leaves a bubble
    // ending mid-thought — the exact thing the sentence rung exists to avoid.
    const reply = "Your acc. 1234 is overdrawn by $18.40 as of this morning and the fee has not posted yet. "
      + "Dr. Smith called about the standing order on it and wants it moved to the joint account instead. "
      + "I can move $50 across from savings to clear the overdraft right now if that suits you.";
    const pieces = bubbles(reply);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join(" ")).toBe(reply);
    // No bubble ends on an abbreviation, and none begins mid-name or mid-number.
    for (const piece of pieces) expect(piece).not.toMatch(/\b(?:acc|no|Dr|Mr|Mrs|Ms|St)\.$/);
    for (const piece of pieces) expect(piece).not.toMatch(/^(?:Smith|1234)\b/);
  });

  it("keeps the abbreviations a title list would never have caught", () => {
    // The predictable leak in a list of titles: a month and an initialism are
    // both followed by a capital and neither is Mr or Dr. The initialism family
    // is closed structurally (an internal period), the months by name.
    const reply = "I sent the statement over on Jan. The copy sitting in the app is the very same one. "
      + "Some fees are waived below $25, e.g. The overdraft charge from Tuesday, which is already credited. "
      + "Tell me if you would rather I posted a paper copy out to you instead this month.";
    const pieces = bubbles(reply);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join(" ")).toBe(reply);
    for (const piece of pieces) expect(piece).not.toMatch(/\b(?:Jan|e\.g|i\.e|a\.m|p\.m|etc|vs|No)\.$/);
  });

  it("leaves alone what it cannot cut honestly", () => {
    const short = "Your checking balance is $412.08. Anything else?";
    expect(bubbles(short)).toEqual([short]);
    // Long, but one unbroken clause: every available cut is mid-sentence, so
    // there is no honest one and the wall is the lesser evil.
    const runOn = `Your balances are ${Array.from({ length: 30 }, (_, i) => `account ${i} at $${i}0.00`).join(", ")}`;
    expect(runOn.length).toBeGreaterThan(240);
    expect(bubbles(runOn)).toEqual([runOn]);
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
