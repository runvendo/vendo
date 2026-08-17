/**
 * ONE inbound text → ONE harness turn → ONE text back.
 *
 * It does NOT go through the away runner: an away run hardcodes
 * `presence: "away"` (agents/src/away.ts), which is exactly wrong here — there
 * IS a person on the other end, holding their phone, and the whole point of the
 * approval bridge below is that they can answer. So the ctx is built locally:
 * `venue: "chat"`, `presence: "present"`, the subject from the link, and the
 * delivery's `eventId` as the conversation the guard scopes its cards by.
 */
import {
  AGENT_CONTEXT_MARK,
  type ApprovalRequest,
  type Principal,
  type RunContext,
} from "@vendoai/core";
import type { VendoGuard } from "@vendoai/guard";
import { THREAD_ID_HEADER } from "@vendoai/harnesses";
import type { UIMessage } from "ai";
import type { ChannelAskRepository, ChannelLink, ChannelLinkRepository } from "./channel-links.js";
import type { ChannelsService, InboundTextEvent } from "./channels.js";
import type { HarnessTurns } from "./harness-turn.js";

/** Texting humans reply on a human clock — they put the phone down, they drive,
 *  they come back. The web's 90s wait is a closed-tab bound and would time out
 *  every real approval here.
 *
 *  WHAT THIS REQUIRES OF A HOST: the parked call is resumed by the instance that
 *  parked it. The guard's decision callbacks are in-process (`guard.ts`
 *  `#approvalCallbacks`) and the waiter is an in-process promise
 *  (`turn-tools.ts`), so a "YES" delivered to a DIFFERENT instance decides the
 *  approval record without waking the turn that is holding the call — the answer
 *  is understood and recorded, and the effect still does not land. So
 *  approve-by-text needs a deployment that keeps one long-lived process for the
 *  ten minutes: a container host (Railway, Render, Fly), not a function that is
 *  billed by the second and killed well inside the window. Making it survive a
 *  restart or a second replica is resumable turns — a durable job that re-enters
 *  the tool call once the record is decided — which is an architecture, not a
 *  patch, and is deliberately NOT in this change. */
export const CHANNEL_APPROVAL_WAIT_MS = 600_000;

/** Rolling threads: a burst keeps its context, and a conversation that has been
 *  quiet for a day starts fresh. The old thread stays in the store and shows up
 *  in the host app's history like any web chat. */
const THREAD_IDLE_MS = 24 * 60 * 60_000;

/** The house style for this channel, delivered the way every other hidden
 *  grounding is (01-core's AGENT_CONTEXT_MARK): a text part the model reads and
 *  the person never sees. There is no host-facing knob for it — a text is a
 *  text. */
const TEXT_STYLE = [
  `${AGENT_CONTEXT_MARK} This conversation is happening over text message.`,
  "Write like a text: one short paragraph, plain sentences, no markdown, no headings, no bullet lists, no links unless asked.",
  "Never mention that you are texting. If you need a yes or no, ask for it in one line.",
  // Delivery does not exist yet: nothing can send a text on a schedule or of its
  // own accord. So the channel must not OFFER it either — an agent that promises
  // Friday's text has already broken a promise the product cannot keep.
  "You cannot send scheduled, recurring or unprompted texts, and you cannot set any of that up from here — say so plainly if asked, point to the app, and say it is coming soon.",
].join(" ");

/** What a turn says when it produced no words at all — a failure that never
 *  reached the stream as text. Silence is not an option on a channel where
 *  somebody is holding their phone waiting for an answer. */
const NOTHING_TO_SAY = "Something went wrong on my end. Try that again in a moment.";

const YES = /^y(es)?$/i;
const NO = /^n(o)?$/i;

export interface ChannelTurnDeps {
  harness: Pick<HarnessTurns, "stream">;
  guard: VendoGuard;
  channel: ChannelsService;
  links: ChannelLinkRepository;
  /** Which cards actually went out over this channel — see
   *  `ChannelAskRepository`, and why it is in the store and not in memory. */
  asks: ChannelAskRepository;
}

/** What the person is told when a call parks: the exact action and its exact
 *  arguments, because a yes over text is consent given without a screen. */
function approvalText(request: ApprovalRequest): string {
  const what = request.descriptor.title ?? request.descriptor.name;
  const detail = request.inputPreview.trim();
  return [
    `${what} needs your OK${detail === "" ? "" : `: ${detail}`}`,
    "Reply YES to go ahead, or NO to cancel.",
  ].join("\n");
}

/** The assistant's words for the turn, read back off the SSE the harness door
 *  answers with. Keepalives are comment frames and never match `data: `. */
async function assistantText(response: Response): Promise<string> {
  const body = await response.text();
  let text = "";
  for (const frame of body.split("\n\n")) {
    if (!frame.startsWith("data: ")) continue;
    const payload = frame.slice("data: ".length);
    if (payload === "[DONE]") continue;
    const chunk = JSON.parse(payload) as { type?: string; delta?: string };
    if (chunk.type === "text-delta" && typeof chunk.delta === "string") text += chunk.delta;
  }
  return text.trim();
}

/** The thread this text belongs to: the conversation's OWN thread while it is
 *  still warm, a fresh one after a day of silence. The channel keeps its own
 *  rather than reopening whatever the subject touched last — the newest thread
 *  is usually a live web chat, and a text turn would both hijack it and persist
 *  the texting style into every later web turn on it. */
function rollingThread(link: ChannelLink): string | undefined {
  if (link.threadId === undefined || link.lastTurnAt === undefined) return undefined;
  return Date.now() - Date.parse(link.lastTurnAt) < THREAD_IDLE_MS ? link.threadId : undefined;
}

/**
 * Run one inbound text as the linked user.
 *
 * A bare YES/NO answering a card THIS conversation raised is not a turn at all:
 * it is the answer to that card, decided on the SAME approval record the
 * waiting turn is blocked on — so that turn resumes and delivers its own reply.
 */
export async function runChannelTurn(
  deps: ChannelTurnDeps,
  input: { event: InboundTextEvent; link: ChannelLink },
): Promise<void> {
  const { event, link } = input;
  const principal: Principal = { kind: "user", subject: link.subject };
  const ctx: RunContext = {
    principal,
    venue: "chat",
    presence: "present",
    sessionId: event.eventId,
    // What authenticates this turn's HOST calls. `presence: "present"` is true —
    // a person is holding their phone, which is what lets the guard ask them to
    // approve a payment — but there is no browser request here, so there are no
    // credentials to forward. Without this the actions layer takes the present
    // path, calls the host API with nothing, and the agent ends up apologising
    // for a sign-in problem the person cannot do anything about.
    channelLink: { channel: "text", linkedAt: link.linkedAt ?? new Date().toISOString() },
  };
  const send = (text: string): Promise<void> =>
    deps.channel.send({ conversationId: event.conversationId, text });

  const answer = event.text.trim();
  if (YES.test(answer) || NO.test(answer)) {
    const asked = await deps.asks.ids(event.conversationId);
    const mine = (await deps.guard.approvals.pending(principal))
      .filter((request) => asked.includes(request.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1);
    if (mine !== undefined) {
      await deps.guard.approvals.decide(mine.id, { approve: YES.test(answer) }, principal);
      await deps.asks.consume(mine.id);
      return;
    }
  }

  // Subscribed BEFORE the turn: a card can be raised inside the first tool
  // call, and a late subscribe would miss it. Scoped to this conversation, so a
  // parallel web turn's card never goes out over SMS. The send is RETURNED, not
  // floated: the guard awaits a returned thenable inside its own try/catch
  // (guard.ts), so a vendor blip becomes a swallowed notification instead of an
  // unhandled rejection that takes the host process down.
  const unsubscribe = deps.guard.onApprovalRequested((request) => {
    if (request.ctx.principal.subject !== link.subject) return undefined;
    if (request.ctx.sessionId !== event.eventId) return undefined;
    // Answerable only once the ask has LANDED. Recording it before the send
    // would leave a card decidable by a later bare YES even though the text
    // carrying its action and arguments never arrived — consent for a
    // money-moving call, given on a surface that never showed it, which is the
    // exact failure the ask rows exist to prevent. A rejected send leaves it
    // unrecorded, so it stays unanswerable and the turn times out instead.
    return send(approvalText(request)).then(() => deps.asks.add(link.subject, event.conversationId, request.id));
  });
  try {
    const threadId = rollingThread(link);
    const message = {
      id: `msg_${event.eventId}`,
      role: "user",
      parts: [{ type: "text", text: event.text }, { type: "text", text: TEXT_STYLE }],
    } as UIMessage;
    const response = await deps.harness.stream({
      ...(threadId === undefined ? {} : { threadId }),
      message,
      ctx,
      approvalWaitMs: CHANNEL_APPROVAL_WAIT_MS,
    });
    // The effective thread, reopened or freshly minted — every door that serves
    // a turn stamps the same header.
    const effective = response.headers.get(THREAD_ID_HEADER);
    if (effective !== null) await deps.links.rememberTurn(link, effective);
    const text = await assistantText(response);
    await send(text === "" ? NOTHING_TO_SAY : text);
  } finally {
    unsubscribe();
  }
}
