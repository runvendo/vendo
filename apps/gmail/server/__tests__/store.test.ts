import { describe, expect, it } from "vitest";
import { MailStore, UnknownMessageError, type MailMessage } from "../store";

const ME = { name: "Yousef", email: "yousef@acmelabs.dev" };

const msg = (over: Partial<MailMessage>): MailMessage => ({
  id: "m0",
  from: { name: "Sender", email: "sender@example.com" },
  to: [ME],
  subject: "Subject",
  body: "Body",
  snippet: "Body",
  date: "2026-07-01T10:00:00.000Z",
  folder: "inbox",
  starred: false,
  unread: false,
  ...over,
});

const SEED: MailMessage[] = [
  msg({ id: "m1", subject: "Oldest", date: "2026-06-30T08:00:00.000Z", unread: true }),
  msg({
    id: "m2",
    from: { name: "Sarah Kim", email: "sarah@acmelabs.dev" },
    subject: "Q3 planning doc",
    body: "Comments on the roadmap and the billing migration.",
    date: "2026-07-02T10:42:00.000Z",
    unread: true,
    starred: true,
  }),
  msg({ id: "m3", subject: "Middle", date: "2026-07-01T09:00:00.000Z" }),
  msg({ id: "s1", subject: "Previously sent", folder: "sent", date: "2026-06-29T12:00:00.000Z" }),
];

const makeStore = () =>
  new MailStore(SEED, ME, { now: () => new Date("2026-07-02T12:00:00.000Z") });

describe("MailStore.list", () => {
  it("defaults to inbox, newest first", () => {
    const ids = makeStore().list().map((m) => m.id);
    expect(ids).toEqual(["m2", "m3", "m1"]);
  });

  it("filters by unread", () => {
    const ids = makeStore().list({ unread: true }).map((m) => m.id);
    expect(ids).toEqual(["m2", "m1"]);
  });

  it("filters by starred and folder", () => {
    expect(makeStore().list({ starred: true }).map((m) => m.id)).toEqual(["m2"]);
    expect(makeStore().list({ folder: "sent" }).map((m) => m.id)).toEqual(["s1"]);
  });

  it("searches sender, subject and body case-insensitively", () => {
    const store = makeStore();
    expect(store.list({ q: "sarah" }).map((m) => m.id)).toEqual(["m2"]);
    expect(store.list({ q: "BILLING migration" }).map((m) => m.id)).toEqual(["m2"]);
    expect(store.list({ q: "oldest" }).map((m) => m.id)).toEqual(["m1"]);
  });

  it("applies limit after sorting", () => {
    expect(makeStore().list({ limit: 2 }).map((m) => m.id)).toEqual(["m2", "m3"]);
  });

  it("orders correctly across mixed ISO offset formats", () => {
    const store = new MailStore(
      [
        // 08:31-07:00 = 15:31Z — later than 12:00Z despite smaller clock digits.
        msg({ id: "offset", date: "2026-07-02T08:31:00-07:00" }),
        msg({ id: "zulu", date: "2026-07-02T12:00:00.000Z" }),
      ],
      ME,
    );
    expect(store.list().map((m) => m.id)).toEqual(["offset", "zulu"]);
  });

  it("returns copies — mutating a result does not corrupt the store", () => {
    const store = makeStore();
    store.list()[0]!.subject = "TAMPERED";
    expect(store.get("m2")!.subject).toBe("Q3 planning doc");
  });
});

describe("MailStore.send", () => {
  it("creates a sent message from me with a snippet and timestamp", () => {
    const store = makeStore();
    const sent = store.send({ to: "anna@example.com", subject: "Hi", body: "Hello there" });
    expect(sent.from).toEqual(ME);
    expect(sent.folder).toBe("sent");
    expect(sent.date).toBe("2026-07-02T12:00:00.000Z");
    expect(store.list({ folder: "sent" }).map((m) => m.id)).toContain(sent.id);
  });

  it("defaults recipient and Re: subject from inReplyTo", () => {
    const sent = makeStore().send({ inReplyTo: "m2", body: "On it." });
    expect(sent.to[0]).toEqual({ name: "Sarah Kim", email: "sarah@acmelabs.dev" });
    expect(sent.subject).toBe("Re: Q3 planning doc");
    expect(sent.inReplyTo).toBe("m2");
  });

  it("does not double the Re: prefix", () => {
    const store = new MailStore(
      [msg({ id: "r1", subject: "Re: thread" })],
      ME,
      { now: () => new Date("2026-07-02T12:00:00.000Z") },
    );
    expect(store.send({ inReplyTo: "r1", body: "x" }).subject).toBe("Re: thread");
  });

  it("rejects a send with no recipient or empty body", () => {
    expect(() => makeStore().send({ subject: "x", body: "y" })).toThrow(/to/);
    expect(() => makeStore().send({ to: "a@b.c", subject: "x", body: "  " })).toThrow(/body/);
  });
});

describe("MailStore mutations", () => {
  it("delete moves to trash (out of inbox, visible in trash)", () => {
    const store = makeStore();
    store.delete("m2");
    expect(store.list().map((m) => m.id)).toEqual(["m3", "m1"]);
    expect(store.list({ folder: "trash" }).map((m) => m.id)).toEqual(["m2"]);
  });

  it("markRead flips unread; setStarred flips starred", () => {
    const store = makeStore();
    expect(store.markRead("m2", true).unread).toBe(false);
    expect(store.setStarred("m3", true).starred).toBe(true);
  });

  it("throws UnknownMessageError for missing ids", () => {
    expect(() => makeStore().delete("nope")).toThrow(UnknownMessageError);
    expect(makeStore().get("nope")).toBeUndefined();
  });

  it("reset restores the seed", () => {
    const store = makeStore();
    store.delete("m2");
    store.send({ to: "a@b.c", subject: "x", body: "y" });
    store.reset();
    expect(store.list().map((m) => m.id)).toEqual(["m2", "m3", "m1"]);
    expect(store.list({ folder: "sent" }).map((m) => m.id)).toEqual(["s1"]);
  });
});
