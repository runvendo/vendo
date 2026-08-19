/**
 * ONE inbound text → ONE harness turn → the texts it writes back, each sent as
 * it finishes rather than all at once (`streamTexts`).
 *
 * It does NOT go through the away runner: an away run hardcodes
 * `presence: "away"` (agents/src/away.ts), which is exactly wrong here — there
 * IS a person on the other end, holding their phone, and the whole point of the
 * approval bridge below is that they can answer. So the ctx is built locally:
 * `venue: "chat"`, `presence: "present"`, the subject from the link, and the
 * delivery's `eventId` as the conversation the guard scopes its cards by.
 */
import { automationName, type AutomationsEngine } from "@vendoai/automations";
import {
  AGENT_CONTEXT_MARK,
  log,
  type ApprovalRequest,
  type AutomationId,
  type Membership,
  type Principal,
  type RunContext,
} from "@vendoai/core";
import type { VendoGuard } from "@vendoai/guard";
import { THREAD_ID_HEADER } from "@vendoai/harnesses";
import type { UIMessage } from "ai";
import type {
  ChannelAskRepository,
  ChannelGrantSetAsk,
  ChannelLink,
  ChannelLinkRepository,
} from "./channel-links.js";
import type { ChannelsService, InboundTextEvent } from "./channels.js";
import { SERVER_AUTHORED, type HarnessTurns } from "./harness-turn.js";

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

/** How a text READS, stated once. Shared with the Text me tool's descriptor
 *  (text-me.ts): a text the agent sends from a web turn or an away firing is
 *  still a text, and two copies of this sentence would drift. */
export const PLAIN_TEXT_RULE =
  "Write like a text: one short paragraph, plain sentences, no markdown, no headings, no bullet lists, "
  + "no links unless asked.";

/** FROZEN: the cut point between two model-authored texts is a line whose only
 *  content is this. Both halves of the contract read it here — the sentence that
 *  teaches it (TEXT_STYLE) and the reader that acts on it (`streamTexts`) — so
 *  the instruction and the parser can never drift apart. */
const DIVIDER = "---";

/** The house style for this channel, delivered the way every other hidden
 *  grounding is (01-core's AGENT_CONTEXT_MARK): a text part the model reads and
 *  the person never sees. There is no host-facing knob for it — a text is a
 *  text. */
const TEXT_STYLE = [
  `${AGENT_CONTEXT_MARK} This conversation is happening over text message.`,
  PLAIN_TEXT_RULE,
  "Never mention that you are texting. If you need a yes or no, ask for it in one line.",
  // Live incident 2026-08-18. This sentence rides as hidden context on EVERY
  // inbound text, so next to "send $25 to Dana" the old wording — "you cannot
  // send … from here, point to the app" — read as a channel-wide restriction:
  // the model refused four transfer asks verbatim ("do that directly in the
  // Maple app") without ever searching its tool catalog, on a prompt carrying
  // three copies of the search-first instruction. The web surface, which has no
  // such note, sends money fine — the note itself taught the refusal. It was
  // also false about automations, which a texted user CAN set up. So the limit
  // is stated as the ONE thing it actually is, and the escape hatch is named:
  // `vendo_text_me` (text-me.ts) is how a later text gets sent.
  "To text the user later, set up an automation for it — the Text me action is how an automation reaches this "
  + "phone, and its grant is part of arming. You cannot otherwise send scheduled, recurring or unprompted texts. "
  + "That is this channel's only limit: anything else your tools can do, you can do right here in this conversation.",
  // The model decides where one text ends and the next begins, because only it
  // knows what it is about to say. A divider line is the cut point and is
  // stripped, never delivered (`streamTexts`), and each text goes out the moment
  // its divider passes rather than waiting for the turn to finish. There is no
  // structural fallback: a reply with no divider in it is simply one text.
  `Separate distinct texts with a line containing only ${DIVIDER}. Each one is sent as its own message the `
  + "moment you finish it, so split anything a person would send as two texts instead of writing one long one.",
].join(" ");

/** What a turn says when it produced no words at all — a failure that never
 *  reached the stream as text. Silence is not an option on a channel where
 *  somebody is holding their phone waiting for an answer. */
const NOTHING_TO_SAY = "Something went wrong on my end. Try that again in a moment.";

const YES = /^y(es)?$/i;
const NO = /^n(o)?$/i;

export interface ChannelTurnDeps {
  /** `warm` is optional for the same reason the web's warm door is
   *  (`wire/threads.ts`): an engine assembled through `createAgent` has none,
   *  and an unwarmed turn is slower, never broken. */
  harness: Pick<HarnessTurns, "stream"> & Partial<Pick<HarnessTurns, "warm">>;
  guard: VendoGuard;
  channel: ChannelsService;
  links: ChannelLinkRepository;
  /** Which cards actually went out over this channel — see
   *  `ChannelAskRepository`, and why it is in the store and not in memory. */
  asks: ChannelAskRepository;
  /** Read-only, and only to NAME an automation whose grant set is being asked
   *  about: the asks themselves are read off the guard's pending feed. */
  automations: Pick<AutomationsEngine, "get">;
  /** Build contract §9.1 — the host's orgs for the LINKED subject. The seam is
   *  keyed on the principal rather than the request precisely so a session-less
   *  path can ask it, and a texted turn must: without it a member who texts is in
   *  none of their org's pools, so their messages and builds neither count against
   *  the org's allowance nor accrue to it. */
  memberships?: (principal: Principal) => Promise<Membership[]>;
}

/** A schema property description cut down to a label: everything before the
 *  first example or parenthetical ("Amount to send in cents (positive whole
 *  number), e.g. …" → "Amount to send in cents"). Falls back to the key name
 *  spaced out of its snake_case. */
function argLabel(key: string, schema: ApprovalRequest["descriptor"]["inputSchema"]): string {
  const properties = schema["properties"];
  const property = typeof properties === "object" && properties !== null
    ? (properties as Record<string, unknown>)[key] : undefined;
  const description = typeof property === "object" && property !== null
    && typeof (property as Record<string, unknown>)["description"] === "string"
    ? (property as Record<string, unknown>)["description"] as string : undefined;
  const label = description?.split(/[.(,]/)[0]?.trim();
  return label && label.length <= 60 ? label : key.replace(/[_-]+/g, " ");
}

/** The common cron shapes an agent actually mints, in words — anything else
 *  stays raw. Used beside the raw expression, never instead of it: the ask is
 *  the consent boundary, so the verbatim value always shows. */
export function cronProse(cron: string): string | undefined {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  if (dayOfMonth !== "*" || month !== "*") return undefined;
  const at = (h: string, m: string) => `${h}:${m.padStart(2, "0")}`;
  if (dayOfWeek !== "*") {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return /^[0-6]$/.test(dayOfWeek) && /^\d+$/.test(minute) && /^\d+$/.test(hour)
      ? `every ${days[Number(dayOfWeek)]} at ${at(hour, minute)}` : undefined;
  }
  const everyN = (field: string) => /^\*\/\d+$/.test(field) ? field.slice(2) : undefined;
  if (hour === "*") {
    if (minute === "*") return "every minute";
    const n = everyN(minute);
    if (n !== undefined) return `every ${n} minutes`;
    if (/^\d+$/.test(minute)) return minute === "0" ? "every hour" : `every hour at :${minute.padStart(2, "0")}`;
    return undefined;
  }
  if (!/^\d+$/.test(minute)) return undefined;
  const nHours = everyN(hour);
  if (nHours !== undefined) return `every ${nHours} hours`;
  return /^\d+$/.test(hour) ? `daily at ${at(hour, minute)}` : undefined;
}

const ARG_VALUE_CAP = 200;

/** What the person is told when a call parks: the exact action and its exact
 *  arguments, because a yes over text is consent given without a screen. One
 *  plain line per argument, labelled from the host's own schema — never the
 *  tool identifier and never a JSON blob, which is what this used to read as
 *  ("host_transferMoney {\"amount\":2500…}" for a $25.00 send, live
 *  2026-08-18). Values stay verbatim — the ask is the safety boundary, so no
 *  model paraphrase — capped only so one huge argument cannot flood a text. */
function approvalText(request: ApprovalRequest): string {
  const what = request.descriptor.title ?? request.descriptor.name;
  const input = request.call.args;
  const lines = input && typeof input === "object" && !Array.isArray(input)
    ? Object.entries(input).map(([key, value]) => {
      const raw = typeof value === "string" ? value : JSON.stringify(value);
      const prose = typeof value === "string" ? cronProse(value) : undefined;
      const shown = prose !== undefined ? `${prose} (${raw})`
        : raw.length > ARG_VALUE_CAP ? `${raw.slice(0, ARG_VALUE_CAP)}… (truncated)` : raw;
      return `- ${argLabel(key, request.descriptor.inputSchema)}: ${shown}`;
    })
    : [];
  // What this yes hands over BEYOND the call itself, when the ask is one that
  // authorizes future unattended work — arming an automation (07 §3). It reads as
  // one more labelled line because that is what it is: another fact about what is
  // being allowed, in the same voice as the arguments above it, human titles only.
  //
  // The set is computed at park time and rides on the approval, so this renders
  // what it is given and decides nothing. That is the whole design: the powers are
  // not a property of texting, and the web card reads the same field when it
  // learns to.
  const powers = request.powers ?? [];
  const detail = [
    ...(lines.length > 0 ? lines : [request.inputPreview.trim()].filter(Boolean)),
    ...(powers.length === 0 ? [] : [`- Powers it will hold: ${powers.join(", ")}`]),
  ];
  return [
    // "approval", never "OK" — the decider matches only YES/NO, and a header
    // that says OK teaches the one reply that will NOT decide it. The em dash
    // keeps verb-phrase titles from reading as a sentence collision ("Set this
    // to run on its own needs your approval").
    `${what} — needs your approval${detail.length === 0 ? "" : ":"}`,
    ...detail,
    "Reply YES to approve, or NO to cancel.",
  ].join("\n");
}

/**
 * The one text a whole grant set goes out as.
 *
 * Arming an automation captures a standing-permission ask per thing it will need
 * (automations `consent.ts`), and those asks are approval ROWS the engine writes
 * during the `vendo_automate` call — they never ride the turn's stream, so the
 * mid-turn card watcher above cannot see them. Until this existed their only
 * surface was the host app's web approvals feed, which a person who only ever
 * texts can never reach: live 2026-08-18 a user armed "check my balance every 15
 * minutes and text me" entirely over iMessage, the arming YES landed, and every
 * firing then ran without the Text me permission while the agent told them
 * "there are still some permissions pending approval".
 *
 * ONE text for the whole set, because the set exists precisely so one decision
 * settles everything outstanding. The automation is named the way every other
 * surface names it, and each line is the descriptor's own human title — never a
 * tool identifier, which is design §3's voice law and the same rule
 * `approvalText` follows.
 */
function grantSetText(name: string, titles: readonly string[]): string {
  return [
    `${name} — needs your permission to run on its own:`,
    ...titles.map((title) => `- ${title}`),
    "Reply YES to allow all of these, or NO to cancel it.",
  ].join("\n");
}

/** What a decided set is answered with. A set ask has no parked turn behind it to
 *  speak for itself — unlike a card, where the turn that was blocked delivers its
 *  own reply — so these two sentences are the whole receipt. The NO wording says
 *  what a bare no actually DOES: `handleDecision` disarms a consent moment that
 *  ended with nothing granted (automations `consent.ts`). */
const SET_ALLOWED = "Done — it can run on its own now.";
const SET_CANCELLED = "Okay — I turned it off.";

/** The automation grant asks this subject has outstanding, grouped by the
 *  automation they belong to, oldest first.
 *
 *  Read off the guard's own pending feed rather than the engine's capture rows: a
 *  pending `venue: "automation"` approval carrying an automation id is exactly
 *  what a capture is the ask for, it is already scoped to this subject, and it
 *  arrives with the descriptor whose title the text prints. A goal firing's own
 *  away ask lands here too, and should — it settles into the same standing grant
 *  through the same subscriber, and it is just as unanswerable over text. */
function grantSetsByAutomation(pending: readonly ApprovalRequest[]): Map<AutomationId, ApprovalRequest[]> {
  const sets = new Map<AutomationId, ApprovalRequest[]>();
  for (const request of [...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const automationId = request.ctx.venue === "automation" ? request.ctx.trigger?.automationId : undefined;
    if (automationId === undefined) continue;
    const group = sets.get(automationId);
    if (group === undefined) sets.set(automationId, [request]);
    else group.push(request);
  }
  return sets;
}

/** The set ask this conversation is still waiting on, or null.
 *
 *  A row whose approvals are all decided somewhere else — the web feed, the
 *  guard's TTL sweep — is SPENT, not outstanding, so it is consumed here: one
 *  abandoned set must never become a permanent block on every later one. */
async function outstandingSet(
  deps: Pick<ChannelTurnDeps, "asks">,
  conversationId: string,
  pending: readonly ApprovalRequest[],
): Promise<ChannelGrantSetAsk | null> {
  const row = await deps.asks.setAsk(conversationId);
  if (row === null) return null;
  const live = row.approvals.filter((id) => pending.some((request) => request.id === id));
  if (live.length > 0) return { automationId: row.automationId, approvals: live };
  await deps.asks.consumeSet(row.automationId);
  return null;
}

/**
 * After the turn: one automation's outstanding permissions, asked over the
 * channel that armed it.
 *
 * ONE question at a time, the discipline the cards already keep: nothing goes out
 * while this conversation is holding a card it has not answered, or a set ask it
 * has not answered — the next turn picks up whatever is still outstanding then.
 * And the row is written only AFTER the text lands, for the same reason
 * `asks.add` is: a set nobody was shown must not be answerable, and a failed
 * delivery should leave the ask to be made again rather than silently spent.
 */
async function offerGrantSet(
  deps: Pick<ChannelTurnDeps, "asks" | "automations">,
  input: { ctx: RunContext; conversationId: string; pending: readonly ApprovalRequest[] },
  send: (text: string) => Promise<void>,
): Promise<void> {
  const { ctx, conversationId, pending } = input;
  const sets = grantSetsByAutomation(pending);
  if (sets.size === 0) return;
  // A card this conversation was shown and has not decided — a park from an
  // earlier turn whose ten-minute waiter is still running. Compared against the
  // LIVE pending feed, never against the rows alone: a card row outlives its
  // approval when something other than a reply decided it, and a stale row must
  // not silence this ask forever.
  const cards = await deps.asks.ids(conversationId);
  if (pending.some((request) => cards.includes(request.id))) return;
  if (await outstandingSet(deps, conversationId, pending) !== null) return;
  for (const [automationId, asks] of sets) {
    const record = await deps.automations.get(automationId, ctx);
    // A record that is gone leaves asks nothing can name; the guard's TTL sweep
    // is what closes those.
    if (record === null) continue;
    const titles = asks.map((ask) => ask.descriptor.title ?? ask.descriptor.name);
    await send(grantSetText(automationName(record), titles));
    await deps.asks.addSet(ctx.principal.subject, conversationId, automationId, asks.map((ask) => ask.id));
    return;
  }
}

/** One SSE frame's contribution to the assistant's words. Keepalives are comment
 *  frames and never match `data: `. */
function frameText(frame: string): string {
  if (!frame.startsWith("data: ")) return "";
  const payload = frame.slice("data: ".length);
  if (payload === "[DONE]") return "";
  const chunk = JSON.parse(payload) as { type?: string; delta?: string };
  return chunk.type === "text-delta" && typeof chunk.delta === "string" ? chunk.delta : "";
}

/**
 * The assistant's words, delivered as they finish instead of all at once.
 *
 * This used to buffer the entire turn and send one message at the end, which is
 * why a texted reply arrived as a wall well after the model had written its
 * first sentence. Now the stream is read as it arrives and every completed
 * segment is sent immediately, so a two-part answer lands the way a person
 * texts: "on it", then the answer.
 *
 * A divider is recognized only once its newline has arrived — deltas split
 * lines anywhere, and a `---` that is still being typed might yet turn into
 * `----`. Answers how many texts went out, so the caller can tell a silent turn
 * from a delivered one.
 *
 * `final` is the same fact read the other way: a cut made while the stream is
 * still open has more of the reply behind it, and one made after the reader is
 * done does not. It cannot be decided at the divider itself — the segment goes
 * out the moment its divider passes, and what follows may be a tool call that
 * takes three seconds or nothing at all — so the end of the stream is what
 * settles it, which is also why a reply signed off with a divider still marks
 * its last text: that cut is only recognized once the stream has ended.
 */
async function streamTexts(
  response: Response,
  send: (text: string, final: boolean) => Promise<void>,
): Promise<number> {
  if (response.body === null) return 0;
  let segment = "";
  let line = "";
  let sent = 0;
  let ended = false;
  const flush = async (): Promise<void> => {
    const text = segment.trim();
    segment = "";
    if (text === "") return;
    sent += 1;
    await send(text, ended);
  };
  const feed = async (delta: string): Promise<void> => {
    line += delta;
    for (let cut = line.indexOf("\n"); cut !== -1; cut = line.indexOf("\n")) {
      const complete = line.slice(0, cut);
      line = line.slice(cut + 1);
      if (complete.trim() === DIVIDER) await flush();
      else segment += `${complete}\n`;
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    for (let cut = buffer.indexOf("\n\n"); cut !== -1; cut = buffer.indexOf("\n\n")) {
      await feed(frameText(buffer.slice(0, cut)));
      buffer = buffer.slice(cut + 2);
    }
  }
  await feed(frameText(buffer));
  // The stream can stop mid-line, and that last line is a line like any other —
  // a reply signed off with a divider and no newline after it must still cut
  // rather than deliver `---` as a text.
  await feed("\n");
  await flush();
  return sent;
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
 * A bare YES/NO answering a card THIS conversation raised is not a turn at all:
 * it is the answer to that card, decided on the SAME approval record the
 * waiting turn is blocked on — so that turn resumes and delivers its own reply.
 *
 * It is decided BEFORE the per-conversation queue (compose-channels.ts), and
 * that ordering is load-bearing rather than tidy: the turn this answer releases
 * is the one holding the queue, so queueing the answer behind it would deadlock
 * the pair for the full ten-minute approval wait and approve-by-text would
 * simply stop working.
 *
 * Answers whether the text was consumed as an answer. A YES that matches no
 * card this conversation raised is NOT one — it falls through and runs as an
 * ordinary turn.
 */
export async function answerPendingCard(
  deps: Pick<ChannelTurnDeps, "guard" | "asks">,
  input: { event: InboundTextEvent; link: ChannelLink },
): Promise<boolean> {
  const answer = input.event.text.trim();
  if (!YES.test(answer) && !NO.test(answer)) return false;
  const principal: Principal = { kind: "user", subject: input.link.subject };
  const asked = await deps.asks.ids(input.event.conversationId);
  const mine = (await deps.guard.approvals.pending(principal))
    .filter((request) => asked.includes(request.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (mine === undefined) return false;
  await deps.guard.approvals.decide(mine.id, { approve: YES.test(answer) }, principal);
  await deps.asks.consume(mine.id);
  return true;
}

/**
 * Run one inbound text as the linked user.
 */
export async function runChannelTurn(
  deps: ChannelTurnDeps,
  input: { event: InboundTextEvent; link: ChannelLink },
): Promise<void> {
  const { event, link } = input;
  const principal: Principal = { kind: "user", subject: link.subject };
  // Asserted, never stored — one call, like the wire's own resolver. A link is
  // minted for a host subject, so this principal is never the ephemeral visitor
  // that resolver skips the seam for.
  //
  // STARTED here and awaited at the ctx, never in front of it: this is a host
  // round trip with somebody holding a phone behind it, and the ctx is the only
  // thing that wants it. A YES that settles a grant set builds no ctx at all, so
  // that path overlaps the call and then walks away from it — which is why the
  // rejection is claimed here, the same bargain `harness-turn.ts`'s `stateRead`
  // makes: a promise nobody awaits still has to land somewhere.
  const membershipsRead = deps.memberships?.(principal);
  void membershipsRead?.catch(() => undefined);
  // Every text this function sends by hand is the turn's last word: a card and a
  // grant-set ask are questions the conversation then waits on, and the two set
  // receipts end the turn. Only `streamTexts` has a mid-reply cut to declare, so
  // it is the only caller that passes the flag.
  const send = (text: string, final = true): Promise<void> =>
    deps.channel.send({ conversationId: event.conversationId, text, final });

  const answer = event.text.trim();
  if (YES.test(answer) || NO.test(answer)) {
    // No card to answer — `answerPendingCard` ran ahead of the queue and would
    // have consumed this text if there were one — but a grant set can be the open
    // question instead. Cards still come first: a card is a turn blocked right
    // now, and one is never sent while a set ask is outstanding, so whichever of
    // the two exists is the last thing this person was shown. This half stays
    // inside the turn rather than jumping the queue with the cards, because a set
    // ask has no parked turn behind it and so nothing to deadlock against.
    const pending = await deps.guard.approvals.pending(principal);
    const set = await outstandingSet(deps, event.conversationId, pending);
    if (set !== null) {
      const approve = YES.test(answer);
      // ONE batch decide, which is what the web feed sends for a grant set too:
      // the guard treats a multi-id decide as a set decision — validated and
      // committed all-or-none, never a half-granted set (guard.ts) — and then
      // fans out to the automations engine's decision subscriber per approval,
      // which is the one path that mints each standing grant. There is no
      // settle-by-set verb on the server: `grantSetId` is a grouping label, and
      // `handleDecision` reads the capture keyed by ONE approval id.
      await deps.guard.approvals.decide([...set.approvals], { approve }, principal);
      await deps.asks.consumeSet(set.automationId);
      await send(approve ? SET_ALLOWED : SET_CANCELLED);
      return;
    }
  }

  const memberships = await membershipsRead;
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
    ...(memberships === undefined ? {} : { memberships }),
  };

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
      // Vouched for in the same breath as the thread id, because the two facts
      // are one fact: a rolling thread exists only because a turn already ran on
      // it, and `message` above was built HERE from a delivery Cloud
      // authenticated — never posted by a client. Without a rolling thread there
      // is nothing to vouch for, so the door reads before it writes as usual.
      ...(threadId === undefined ? {} : { threadId, [SERVER_AUTHORED]: true as const }),
      message,
      ctx,
      approvalWaitMs: CHANNEL_APPROVAL_WAIT_MS,
    });
    // The effective thread, reopened or freshly minted — every door that serves
    // a turn stamps the same header.
    const effective = response.headers.get(THREAD_ID_HEADER);
    // Behind the answer, not in front of it — on a hosted store this write is a
    // network call, and it has two readers, only one of which can run during the
    // turn. `vendo_text_me` reads the CONVERSATION off this row (text-me.ts) and
    // nothing else writes it, so a turn that would CHANGE what it reads — a
    // phone's first ever, a conversation that has moved — still waits for it. The
    // other reader is the next text on this conversation, which reads the THREAD
    // this names; the per-conversation queue cannot start that turn until this
    // one's promise settles (compose-channels.ts), so landing the write below the
    // reply is early enough for it.
    const remembered = effective === null
      ? undefined
      : deps.links.rememberTurn(link, effective, event.conversationId);
    // Claimed the moment it is started, exactly as `membershipsRead` above is: a
    // deferred write is unawaited for as long as the reply takes to go out, and
    // Node's default throw-mode kills the host process over a rejection nobody
    // has reached yet. This marks it handled without swallowing it — the `await`
    // below the reply still sees the failure.
    void remembered?.catch(() => undefined);
    if (link.conversationId !== event.conversationId) await remembered;
    try {
      if (await streamTexts(response, send) === 0) await send(NOTHING_TO_SAY);
    } catch (error) {
      // The adapter already retried this (channels.ts). Past that the reply is
      // gone for good, and the delivery claim is deliberately NOT released:
      // replaying the turn would re-run the tool calls it already made, so a
      // lost sentence would cost a second payment. Loud, because a person is
      // holding a phone that will never answer and only an operator can see it.
      log({
        code: "vendo.channel-reply-lost",
        level: "error",
        message: `[vendo] a text reply was lost on conversation ${event.conversationId}; the turn already ran and is `
          + `not replayed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    // The reply is out; the next text on this conversation is what still needs
    // the write, and it cannot start until this returns.
    await remembered;
    // The next text in this conversation usually arrives inside the provider's
    // cache TTL, so the prefix is warmed once the person already has their
    // reply — never something they wait behind, and a failure costs nothing but
    // the warmth (the same bargain wire/threads.ts makes for the web).
    void deps.harness.warm?.({ ctx }).catch(() => undefined);
    // AFTER the turn's own words, and only then: the standing-permission asks
    // arming raises are approval rows, not stream parts, so nothing inside the
    // turn could have offered them. The pending feed is the source of truth here
    // rather than "did this turn arm something" — a set minted from the WEB gets
    // asked on the next texted turn, which is exactly right.
    await offerGrantSet(
      deps,
      { ctx, conversationId: event.conversationId, pending: await deps.guard.approvals.pending(principal) },
      send,
    );
  } finally {
    unsubscribe();
  }
}