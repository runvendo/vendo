/**
 * The phone ↔ principal binding, and the short code that mints it.
 *
 * LINK FROM PRODUCT, never phone-lookup auth: a link only ever exists because a
 * signed-in user asked for one and then texted its code back. Vendo Cloud knows
 * phone→deployment routing and nothing else; the binding lives HERE, in the
 * deployment's own composed store, so a host owns its users' phone numbers the
 * same way it owns everything else about them.
 *
 * Shaped like `ThreadRepository` (threads.ts): rows through the adapter seam
 * only, so a hosted store serves it too, and the refs carry the subject so
 * `eraseStore().bySubject` sweeps a departing user's link with the rest.
 */
import {
  VendoError,
  type ApprovalId,
  type AutomationId,
  type IsoDateTime,
  type StoreAdapter,
  type VendoRecord,
} from "@vendoai/core";

const LINK_COLLECTION = "vendo_channel_links";
const LINK_ID_PATTERN = /^chl_[0-9a-f]+$/;

const EVENT_COLLECTION = "vendo_channel_events";
/** How long a delivered event id is remembered. Cloud retries a delivery that
 *  did not answer 202, and a retry must never run the turn twice — but the rows
 *  must not pile up for the life of the deployment either, so a claim prunes the
 *  conversation's stale ones as it goes. A day outlasts every retry the broker
 *  will make, and matches the window a conversation itself lives in. */
const DELIVERY_MEMORY_MS = 24 * 60 * 60_000;

/** How often one process bothers to sweep those rows. Pruning is housekeeping,
 *  not correctness — nothing reads a stale row, it is only storage — but it used
 *  to run on EVERY message, re-listing the whole conversation and deleting
 *  row by row before the turn could start. So it becomes a sweep, kept per
 *  conversation: a conversation's first delivery pays for it (which is what
 *  keeps a serverless deployment, where every instance is cold, bounded exactly
 *  as before) and the burst of texts behind it does not. */
const PRUNE_INTERVAL_MS = 60 * 60_000;

const ASK_COLLECTION = "vendo_channel_asks";
/** An approval id IS the row id, and the guard mints them `apr_<uuid>`
 *  (guard.ts:205) — so a row that is not one was not written by this file. */
const ASK_ID_PATTERN = /^apr_[0-9a-f-]+$/;
/** How a grant-SET ask row is told apart from a card row in the one collection.
 *  The prefix is what keeps `ids()` — which admits approval ids only — from ever
 *  handing a set row to the card decider. */
const SET_ID_PREFIX = "set_";

/** Unambiguous alphabet: no O/0, no I/1/L. A person retypes this code from one
 *  message into another, on a phone keyboard. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;

/** What a claim code looks like once normalized — the cheap test an inbound
 *  text passes before it is worth a lookup. */
export const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** How long a minted code stays claimable. Thirty minutes because a person taps
 *  the link on one device and finishes on another, and because the router hands
 *  back a contact card first — the gap between tapping and texting is human, not
 *  mechanical. Still short enough that a code read over someone's shoulder is
 *  worthless by the time they act on it. */
export const LINK_CODE_TTL_MS = 30 * 60_000;

export interface ChannelLink {
  id: string;
  subject: string;
  /** The outstanding claim code. Absent once the link is claimed. */
  code?: string;
  /** When the code stops being claimable. Absent once claimed. */
  expiresAt?: IsoDateTime;
  /** The phone that claimed it, in E.164. Absent while the link is pending. */
  phone?: string;
  linkedAt?: IsoDateTime;
  /** The conversation's rolling thread, and when it last ran. The channel keeps
   *  its OWN thread rather than reusing whatever the subject touched last: the
   *  newest thread is usually a web chat, and a text turn would both hijack it
   *  and persist the texting style into every later web turn on it. */
  threadId?: string;
  lastTurnAt?: IsoDateTime;
  /** The router conversation this phone last texted on — the ONLY address the
   *  channel can send to (`ChannelsService.send` takes a conversation, never a
   *  number, because the deployment never learns the router's addressing). It is
   *  what lets `vendo_text_me` reach this person from a web turn or an away
   *  firing. Absent until they have sent at least one real message: a one-text
   *  link carries no conversation of its own (`InboundLinkEvent`). */
  conversationId?: string;
}

function mintLinkId(): string {
  return `chl_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function mintCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

/** What a person sees when a surface names their linked phone: enough to
 *  recognize their own number, never enough to read someone else's. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `+1 ••• ••• ${digits.slice(-4)}`;
}

/** Codes are compared case- and space-insensitively: the person retyping one
 *  is on a phone keyboard that may capitalize, and they may or may not paste
 *  the spaces around it. */
export function normalizeCode(text: string): string {
  return text.trim().toUpperCase().replace(/\s+/g, "");
}

/** One phone, one spelling. A vendor that delivers `+15551234567` on one
 *  message and `1 (555) 123-4567` on the next would otherwise leave the same
 *  physical phone holding two link rows on two accounts — and the second
 *  spelling would read as a stranger. */
export function normalizePhone(phone: string): string {
  return `+${phone.replace(/\D/g, "")}`;
}

function linkFromRecord(record: VendoRecord): ChannelLink | null {
  if (!LINK_ID_PATTERN.test(record.id)) return null;
  const data = record.data;
  if (typeof data !== "object" || data === null) return null;
  const candidate = data as Partial<ChannelLink>;
  if (typeof candidate.subject !== "string") return null;
  return { ...candidate, id: record.id, subject: candidate.subject };
}

export class ChannelLinkRepository {
  constructor(private readonly store: StoreAdapter) {}

  /** Mint a fresh code for this subject, replacing any code they had
   *  outstanding. An already-claimed link is left alone: asking for a new code
   *  must not silently unlink the phone the user is texting from. */
  async mint(subject: string): Promise<ChannelLink> {
    for (const pending of await this.pendingFor(subject)) {
      await this.records().delete(pending.id);
    }
    const code = await this.freeCode();
    const link: ChannelLink = {
      id: mintLinkId(),
      subject,
      code,
      expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS).toISOString(),
    };
    await this.records().put({ id: link.id, data: link, refs: { subject, code } });
    return link;
  }

  /** The second text of the link: the code arrives from the phone we are about
   *  to bind. Answers the claimed link, or null when the code is unknown,
   *  already spent, or expired. */
  async claim(code: string, rawPhone: string): Promise<ChannelLink | null> {
    const normalized = normalizeCode(code);
    if (!CODE_PATTERN.test(normalized)) return null;
    const phone = normalizePhone(rawPhone);
    const pending = (await this.listBy({ code: normalized }))
      .find((link) => link.phone === undefined && !this.expired(link));
    if (pending === undefined) return null;
    // One phone belongs to one person, and one person to one phone: whatever
    // either side was bound to before is replaced by this claim.
    for (const stale of [...await this.listBy({ phone }), ...await this.claimedFor(pending.subject)]) {
      if (stale.id !== pending.id) await this.records().delete(stale.id);
    }
    const claimed: ChannelLink = {
      id: pending.id,
      subject: pending.subject,
      phone,
      linkedAt: new Date().toISOString(),
    };
    await this.records().put({ id: claimed.id, data: claimed, refs: { subject: claimed.subject, phone } });
    return claimed;
  }

  /** Who this phone is, for an inbound text. NEWEST claim wins: `claim` reads
   *  the rows it replaces and writes separately, so two claims racing on the
   *  same phone with two different live codes can each leave a row behind.
   *  Taking whichever the store happened to list first would then run the
   *  phone's texts as an arbitrary one of the two; ordering by `linkedAt` lands
   *  on the subject a serialized pair would have left bound, which is this
   *  file's rule — the later claim replaces the earlier. */
  async byPhone(rawPhone: string): Promise<ChannelLink | null> {
    const phone = normalizePhone(rawPhone);
    return (await this.listBy({ phone }))
      .filter((link) => link.phone !== undefined)
      .sort((a, b) => (a.linkedAt ?? "").localeCompare(b.linkedAt ?? ""))
      .at(-1) ?? null;
  }

  /** Remember which thread this conversation is running in, and when it last
   *  ran — the two facts `runChannelTurn` rolls the thread on — plus the
   *  conversation itself, which is the address `vendo_text_me` sends to. */
  async rememberTurn(link: ChannelLink, threadId: string, conversationId: string): Promise<void> {
    const updated: ChannelLink = { ...link, threadId, lastTurnAt: new Date().toISOString(), conversationId };
    await this.records().put({
      id: link.id,
      data: updated,
      refs: { subject: link.subject, ...(link.phone === undefined ? {} : { phone: link.phone }) },
    });
  }

  /** This subject's claimed link, if they have one. */
  async bySubject(subject: string): Promise<ChannelLink | null> {
    return (await this.claimedFor(subject))[0] ?? null;
  }

  /** Drop everything this subject has here — the claimed phone and any code
   *  still outstanding. */
  async unlink(subject: string): Promise<void> {
    for (const link of await this.listBy({ subject })) {
      await this.records().delete(link.id);
    }
  }

  private records(): ReturnType<StoreAdapter["records"]> {
    return this.store.records(LINK_COLLECTION);
  }

  private expired(link: ChannelLink): boolean {
    return link.expiresAt !== undefined && Date.parse(link.expiresAt) <= Date.now();
  }

  private async pendingFor(subject: string): Promise<ChannelLink[]> {
    return (await this.listBy({ subject })).filter((link) => link.phone === undefined);
  }

  private async claimedFor(subject: string): Promise<ChannelLink[]> {
    return (await this.listBy({ subject })).filter((link) => link.phone !== undefined);
  }

  /** A 6-character code is retyped by a human, so it is short enough that two
   *  live codes could collide — and a collision would hand one person's link to
   *  another. Mint against the rows that exist. */
  private async freeCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = mintCode();
      if ((await this.listBy({ code })).length === 0) return code;
    }
    throw new VendoError("conflict", "could not mint a free text-channel code");
  }

  /** Follows the store's pagination cursor to exhaustion, like
   *  ThreadRepository.listRecords. */
  private async listBy(refs: Record<string, string>): Promise<ChannelLink[]> {
    const links: ChannelLink[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.records().list({ refs, ...(cursor === undefined ? {} : { cursor }) });
      for (const record of page.records) {
        const link = linkFromRecord(record);
        if (link !== null) links.push(link);
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return links;
  }
}

/**
 * The approvals THIS conversation asked about.
 *
 * Load-bearing, not bookkeeping: a "YES" must only ever decide a card that went
 * out over this channel. `guard.approvals.pending` is scoped to the subject, so
 * deciding the newest pending one would let a text approve the card the person
 * is looking at in a web tab — consent for a money-moving call, given on a
 * surface that never showed it.
 *
 * In the STORE rather than in memory, because the ask and its answer arrive as
 * two separate inbound deliveries and a deployment is a request handler: on a
 * serverless host those two land on different instances, and a restart parts
 * them anywhere. A composition-scoped map answers the second delivery with an
 * empty set, so the "YES" reads as an ordinary message and the card the person
 * WAS shown sits pending until it times out. Rows carry the subject, so
 * `eraseStore().bySubject` sweeps them with the link.
 */
export class ChannelAskRepository {
  constructor(private readonly store: StoreAdapter) {}

  /** Remember that this conversation was told about this approval. The approval
   *  id is the row id, so recording the same ask twice leaves one row. */
  async add(subject: string, conversationId: string, approvalId: ApprovalId): Promise<void> {
    await this.records().put({
      id: approvalId,
      data: { subject, conversationId },
      refs: { subject, conversation: conversationId },
    });
  }

  /** The approvals this conversation may answer. */
  async ids(conversationId: string): Promise<readonly ApprovalId[]> {
    const ids: ApprovalId[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.records().list({
        refs: { conversation: conversationId },
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const record of page.records) {
        if (ASK_ID_PATTERN.test(record.id)) ids.push(record.id as ApprovalId);
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return ids;
  }

  /** Spend the row the moment its card is decided: a card answered once is not
   *  answerable again, and the rows must not outlive the conversations. */
  async consume(approvalId: ApprovalId): Promise<void> {
    await this.records().delete(approvalId);
  }

  /** Remember that this conversation was asked about one automation's whole set
   *  of outstanding permissions, and which approvals that one text covers.
   *
   *  Keyed by the AUTOMATION, not by the engine's own `gset_` id: the engine
   *  mints exactly one grant set per record — arming reuses the record's still
   *  pending set and a fire-time miss joins it (automations `consent.ts`,
   *  `captureGrants` and `needsPermission`) — so the automation names the same
   *  set without this file reading the engine's private capture rows. The row
   *  lives from the moment the text lands until a YES or NO settles it, which
   *  makes it both what a bare reply routes to and the memory that stops a later
   *  turn asking the same set twice. */
  async addSet(
    subject: string,
    conversationId: string,
    automationId: AutomationId,
    approvals: readonly ApprovalId[],
  ): Promise<void> {
    await this.records().put({
      id: `${SET_ID_PREFIX}${automationId}`,
      data: { subject, conversationId, automationId, approvals: [...approvals] },
      refs: { subject, conversation: conversationId },
    });
  }

  /** The grant set ask this conversation is holding, if any. One at a time, like
   *  the cards: whichever row the store lists first is the open question, and
   *  nothing new goes out while one is here. */
  async setAsk(conversationId: string): Promise<ChannelGrantSetAsk | null> {
    let cursor: string | undefined;
    do {
      const page = await this.records().list({
        refs: { conversation: conversationId },
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const record of page.records) {
        if (!record.id.startsWith(SET_ID_PREFIX)) continue;
        const data = record.data as Partial<ChannelGrantSetAsk> | null;
        if (typeof data?.automationId === "string" && Array.isArray(data.approvals)) {
          return { automationId: data.automationId as AutomationId, approvals: data.approvals };
        }
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return null;
  }

  /** Spend the set row: its question has been answered, or answered elsewhere. */
  async consumeSet(automationId: AutomationId): Promise<void> {
    await this.records().delete(`${SET_ID_PREFIX}${automationId}`);
  }

  private records(): ReturnType<StoreAdapter["records"]> {
    return this.store.records(ASK_COLLECTION);
  }
}

/** One automation's outstanding permissions, as this conversation was asked
 *  about them. */
export interface ChannelGrantSetAsk {
  automationId: AutomationId;
  approvals: readonly ApprovalId[];
}

/** The row id for a delivery: a digest, because the id is the vendor's string
 *  and a record id is ours. Hashing keeps two different deliveries from ever
 *  sanitizing down to the same row — which would silently swallow a real text. */
async function deliveryRowId(eventId: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(eventId));
  return `cev_${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Which deliveries this deployment has already run.
 *
 * In the store for the same reason the ask rows are: `eventId` is the wire
 * contract's idempotency key, and a Set in one instance's memory cannot honour
 * it. Cloud retries a delivery that did not answer 202, and on a serverless host
 * that retry is a different instance — which would run the person's text a
 * SECOND time, with a second tool call and a second charge behind it.
 *
 * The claim IS the adapter's conditional insert wherever there is one, so the
 * winner is decided by the store rather than by a read the next copy of the
 * delivery could race.
 *
 * The row holds the event id and a timestamp, never the phone or the text, so
 * there is nothing here for `eraseStore().bySubject` to have to reach.
 */
export class ChannelEventLog {
  constructor(private readonly store: StoreAdapter) {}

  /** Per conversation, not one clock for the process: a single shared clock
   *  lets one chatty conversation spend every interval, and every other
   *  conversation's expired rows are then never considered again. */
  private readonly sweptAt = new Map<string, number>();

  /** True when this delivery is ours to run, false when it already ran. */
  async claim(eventId: string, conversationId: string): Promise<boolean> {
    const id = await deliveryRowId(eventId);
    const records = this.records();
    const row = {
      id,
      data: { eventId, seenAt: new Date(Date.now()).toISOString() },
      refs: { conversation: conversationId },
    };
    // ONE guarded write where the adapter has one (01 §12). This claim is the
    // first thing an inbound text waits on, and read-then-write cost a person two
    // round trips to answer it — while leaving a window where two concurrent
    // copies of one delivery each read the absence and both ran the turn. An
    // adapter without `atomic` keeps that pair, which is what it always had.
    if (records.atomic !== undefined) {
      if (await records.atomic.insertIfAbsent(row) === null) return false;
    } else {
      if (await records.get(id) !== null) return false;
      await records.put(row);
    }
    if (Date.now() - (this.sweptAt.get(conversationId) ?? 0) >= PRUNE_INTERVAL_MS) {
      this.sweptAt.set(conversationId, Date.now());
      await this.prune(conversationId);
    }
    return true;
  }

  /** Drop this conversation's deliveries once they are older than any retry. */
  private async prune(conversationId: string): Promise<void> {
    const cutoff = Date.now() - DELIVERY_MEMORY_MS;
    let cursor: string | undefined;
    do {
      const page = await this.records().list({
        refs: { conversation: conversationId },
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const record of page.records) {
        const seenAt = (record.data as { seenAt?: string } | null)?.seenAt;
        if (seenAt !== undefined && Date.parse(seenAt) < cutoff) await this.records().delete(record.id);
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
  }

  private records(): ReturnType<StoreAdapter["records"]> {
    return this.store.records(EVENT_COLLECTION);
  }
}
