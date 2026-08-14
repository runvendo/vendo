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
import { VendoError, type IsoDateTime, type StoreAdapter, type VendoRecord } from "@vendoai/core";

const LINK_COLLECTION = "vendo_channel_links";
const LINK_ID_PATTERN = /^chl_[0-9a-f]+$/;

/** Unambiguous alphabet: no O/0, no I/1/L. A person retypes this code from one
 *  message into another, on a phone keyboard. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;

/** What a claim code looks like once normalized — the cheap test an inbound
 *  text passes before it is worth a lookup. */
export const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** How long a minted code stays claimable. Long enough for the two-text dance
 *  (text the router, wait for the contact card, text the code), short enough
 *  that a code read over someone's shoulder is worthless by tomorrow. */
export const LINK_CODE_TTL_MS = 15 * 60_000;

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
   *  ran — the two facts `runChannelTurn` rolls the thread on. */
  async rememberTurn(link: ChannelLink, threadId: string): Promise<void> {
    const updated: ChannelLink = { ...link, threadId, lastTurnAt: new Date().toISOString() };
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
