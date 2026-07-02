/**
 * The Gmail clone's mail store — in-memory, seeded, reseedable. This is the
 * single source of truth for the demo mailbox: the REST API (api.ts), the
 * Flowlet in-process action tools, and the frontend (via the API) all read and
 * mutate the same instance, so agent actions are immediately visible in the UI.
 */

export interface MailAddress {
  name: string;
  email: string;
}

export type MailFolder = "inbox" | "sent" | "trash";

export interface MailMessage {
  id: string;
  from: MailAddress;
  to: MailAddress[];
  subject: string;
  body: string;
  snippet: string;
  /** ISO 8601 timestamp. */
  date: string;
  folder: MailFolder;
  starred: boolean;
  unread: boolean;
  /** id of the message this one replies to, when applicable. */
  inReplyTo?: string;
}

export interface ListOptions {
  folder?: MailFolder;
  unread?: boolean;
  starred?: boolean;
  /** Case-insensitive match against sender name/email, subject and body. */
  q?: string;
  limit?: number;
}

export interface SendInput {
  /** Recipient email (name optional via "Name <email>" is NOT parsed — plain email). */
  to?: string;
  subject?: string;
  body: string;
  /** Reply threading: recipient + "Re:" subject default from the original. */
  inReplyTo?: string;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const makeSnippet = (body: string): string =>
  body.length > 140 ? `${body.slice(0, 140).trimEnd()}…` : body;

export class MailStore {
  private messages: MailMessage[] = [];
  private seq = 0;
  /** Bumped on every reset — lets callers scope caches to a seed lifetime. */
  private resetCount = -1;
  private readonly seed: MailMessage[];
  private readonly now: () => Date;

  constructor(
    seed: MailMessage[],
    public readonly me: MailAddress,
    opts: { now?: () => Date } = {},
  ) {
    this.seed = clone(seed);
    this.now = opts.now ?? (() => new Date());
    this.reset();
  }

  reset(): void {
    this.messages = clone(this.seed);
    this.seq = 0;
    this.resetCount += 1;
  }

  get generation(): number {
    return this.resetCount;
  }

  list(opts: ListOptions = {}): MailMessage[] {
    const folder = opts.folder ?? "inbox";
    const q = opts.q?.trim().toLowerCase();
    let out = this.messages.filter((m) => m.folder === folder);
    if (opts.unread !== undefined) out = out.filter((m) => m.unread === opts.unread);
    if (opts.starred !== undefined) out = out.filter((m) => m.starred === opts.starred);
    if (q) {
      out = out.filter((m) =>
        [m.from.name, m.from.email, m.subject, m.body]
          .join("\n")
          .toLowerCase()
          .includes(q),
      );
    }
    // Numeric time sort — seed dates carry a -07:00 offset while send() emits
    // Z-suffixed ISO, so lexicographic comparison would misorder them.
    out = out.slice().sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    return clone(opts.limit ? out.slice(0, opts.limit) : out);
  }

  get(id: string): MailMessage | undefined {
    const found = this.messages.find((m) => m.id === id);
    return found ? clone(found) : undefined;
  }

  send(input: SendInput): MailMessage {
    const original = input.inReplyTo ? this.require(input.inReplyTo) : undefined;
    const toEmail = input.to ?? original?.from.email;
    if (!toEmail) throw new Error("send: `to` is required when not replying");
    const toName = original && original.from.email === toEmail ? original.from.name : toEmail;
    const subject =
      input.subject ??
      (original
        ? original.subject.startsWith("Re:")
          ? original.subject
          : `Re: ${original.subject}`
        : undefined);
    if (!subject) throw new Error("send: `subject` is required when not replying");
    if (!input.body?.trim()) throw new Error("send: `body` is required");

    const message: MailMessage = {
      id: `sent-${++this.seq}`,
      from: { ...this.me },
      to: [{ name: toName, email: toEmail }],
      subject,
      body: input.body,
      snippet: makeSnippet(input.body),
      date: this.now().toISOString(),
      folder: "sent",
      starred: false,
      unread: false,
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
    };
    this.messages.push(message);
    return clone(message);
  }

  delete(id: string): MailMessage {
    const m = this.require(id);
    m.folder = "trash";
    return clone(m);
  }

  markRead(id: string, read: boolean): MailMessage {
    const m = this.require(id);
    m.unread = !read;
    return clone(m);
  }

  setStarred(id: string, starred: boolean): MailMessage {
    const m = this.require(id);
    m.starred = starred;
    return clone(m);
  }

  private require(id: string): MailMessage {
    const found = this.messages.find((m) => m.id === id);
    if (!found) throw new UnknownMessageError(id);
    return found;
  }
}

export class UnknownMessageError extends Error {
  constructor(public readonly id: string) {
    super(`unknown message "${id}"`);
    this.name = "UnknownMessageError";
  }
}
