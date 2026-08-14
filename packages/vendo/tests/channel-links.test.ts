import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalId } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChannelAskRepository,
  ChannelEventLog,
  ChannelLinkRepository,
  LINK_CODE_TTL_MS,
  maskPhone,
} from "../src/channel-links.js";

/**
 * The phone ↔ principal binding: minted from inside the product, claimed by the
 * SECOND text, and scoped to one subject at every step.
 *
 * The binding is the whole security model of the channel — an inbound text is
 * served AS whoever this table says the phone is — so the cases pinned here are
 * the ones that would hand one person's account to another: a code that already
 * expired, a code that was already spent, and a claim leaking across subjects.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function freshStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-channel-links-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.ensureSchema();
  return store;
}

async function repository(): Promise<ChannelLinkRepository> {
  return new ChannelLinkRepository(await freshStore());
}

/** Travel without touching timers: the repository asks `Date.now()`, and PGlite
 *  must keep its own clock. */
const at = (offsetMs: number): void => {
  const now = Date.now() + offsetMs;
  vi.spyOn(Date, "now").mockReturnValue(now);
};

describe("minted codes", () => {
  it("are six characters from an alphabet a person can retype", async () => {
    const links = await repository();
    const codes = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const { code } = await links.mint(`user_${i}`);
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
      codes.add(code!);
    }
    // No O/0, no I/1/L anywhere — the characters a hand-copied code confuses.
    expect([...codes].join("")).not.toMatch(/[O0I1L]/);
    expect(codes.size, "every mint is a fresh code").toBe(25);
  });

  it("replace the subject's outstanding code, so only the newest one claims", async () => {
    const links = await repository();
    const stale = await links.mint("user_a");
    const fresh = await links.mint("user_a");

    expect(await links.claim(stale.code!, "+15550000001")).toBeNull();
    expect((await links.claim(fresh.code!, "+15550000001"))?.subject).toBe("user_a");
  });

  it("stop claiming once they expire", async () => {
    const links = await repository();
    const { code } = await links.mint("user_a");

    at(LINK_CODE_TTL_MS + 1_000);
    expect(await links.claim(code!, "+15550000001")).toBeNull();
    expect(await links.bySubject("user_a")).toBeNull();
  });
});

describe("claiming", () => {
  it("binds the phone to the code's subject, and spends the code", async () => {
    const links = await repository();
    const { code } = await links.mint("user_a");

    const claimed = await links.claim(code!, "+15551230123");
    expect(claimed?.subject).toBe("user_a");
    expect(claimed?.phone).toBe("+15551230123");
    expect(claimed?.code, "a spent code is gone, not merely marked").toBeUndefined();

    // The read path an inbound text takes.
    expect((await links.byPhone("+15551230123"))?.subject).toBe("user_a");
    expect((await links.bySubject("user_a"))?.phone).toBe("+15551230123");

    // Replay: the same code cannot bind a second phone.
    expect(await links.claim(code!, "+15559999999")).toBeNull();
    expect(await links.byPhone("+15559999999")).toBeNull();
  });

  it("never crosses subjects — an unknown code binds nobody", async () => {
    const links = await repository();
    await links.mint("user_a");
    const b = await links.mint("user_b");

    expect(await links.claim("ZZZZZZ", "+15550000002")).toBeNull();
    expect(await links.byPhone("+15550000002")).toBeNull();

    const claimed = await links.claim(b.code!, "+15550000002");
    expect(claimed?.subject).toBe("user_b");
    expect(await links.bySubject("user_a"), "user_a's link is untouched").toBeNull();
  });

  it("moves the phone when it claims a second account, leaving the first unlinked", async () => {
    const links = await repository();
    const a = await links.mint("user_a");
    await links.claim(a.code!, "+15550000003");
    const b = await links.mint("user_b");
    await links.claim(b.code!, "+15550000003");

    expect((await links.byPhone("+15550000003"))?.subject).toBe("user_b");
    expect(await links.bySubject("user_a")).toBeNull();
  });

  it("is case- and space-insensitive, because a person retypes it", async () => {
    const links = await repository();
    const { code } = await links.mint("user_a");
    expect((await links.claim(` ${code!.toLowerCase()} `, "+15550000004"))?.subject).toBe("user_a");
  });

  it("reads one physical phone as one phone, however the vendor spells it", async () => {
    const links = await repository();
    const a = await links.mint("user_a");
    await links.claim(a.code!, "+1 (555) 000-0006");

    // The same phone, delivered in three spellings, is the same link.
    for (const spelling of ["+15550000006", "15550000006", "+1 555-000-0006"]) {
      expect((await links.byPhone(spelling))?.subject).toBe("user_a");
    }
    // And it cannot hold a second row under a second spelling.
    const b = await links.mint("user_b");
    await links.claim(b.code!, "15550000006");
    expect((await links.byPhone("+15550000006"))?.subject).toBe("user_b");
    expect(await links.bySubject("user_a")).toBeNull();
  });
});

describe("unlinking", () => {
  it("drops the phone and any code still outstanding", async () => {
    const links = await repository();
    const first = await links.mint("user_a");
    await links.claim(first.code!, "+15550000005");
    const second = await links.mint("user_a");

    await links.unlink("user_a");

    expect(await links.bySubject("user_a")).toBeNull();
    expect(await links.byPhone("+15550000005")).toBeNull();
    expect(await links.claim(second.code!, "+15550000005")).toBeNull();
  });
});

describe("maskPhone", () => {
  it("shows a person their own number and nobody else's", () => {
    expect(maskPhone("+15551230123")).toBe("+1 ••• ••• 0123");
    expect(maskPhone("+1 (555) 123-0123")).toBe("+1 ••• ••• 0123");
    expect(maskPhone("+15551230123")).not.toContain("555");
  });
});

const APPROVAL = "apr_11111111-1111-1111-1111-111111111111" as ApprovalId;
const OTHER_APPROVAL = "apr_22222222-2222-2222-2222-222222222222" as ApprovalId;

/**
 * The rows that let a bare "YES" mean something.
 *
 * THE FAILURE THESE PIN: the ask and its answer are two separate inbound
 * deliveries, so the copy of the deployment that hears "YES" is not reliably the
 * copy that asked. Holding this in a composition-scoped Map answered the second
 * delivery with an empty set, and the card the person WAS shown became an
 * ordinary message — the answer read as a new question, the card left to time
 * out. Everything here is therefore asserted through a SECOND repository over
 * the same store: a different instance, reading what the first one wrote.
 */
describe("the ask rows a YES is answered from", () => {
  it("are readable by another instance over the same store", async () => {
    const store = await freshStore();
    await new ChannelAskRepository(store).add("user_a", "conv_1", APPROVAL);

    const elsewhere = new ChannelAskRepository(store);
    expect(await elsewhere.ids("conv_1")).toEqual([APPROVAL]);
    // Scoped to the conversation that was actually told: a card texted to one
    // conversation is not answerable from another.
    expect(await elsewhere.ids("conv_2")).toEqual([]);
  });

  it("are spent when the card is decided, so one YES cannot answer twice", async () => {
    const store = await freshStore();
    const asks = new ChannelAskRepository(store);
    await asks.add("user_a", "conv_1", APPROVAL);
    await asks.add("user_a", "conv_1", OTHER_APPROVAL);

    await new ChannelAskRepository(store).consume(APPROVAL);

    expect(await asks.ids("conv_1")).toEqual([OTHER_APPROVAL]);
  });

  it("records one row per card, however many times the ask is retried", async () => {
    const store = await freshStore();
    const asks = new ChannelAskRepository(store);
    await asks.add("user_a", "conv_1", APPROVAL);
    await asks.add("user_a", "conv_1", APPROVAL);

    expect(await asks.ids("conv_1")).toEqual([APPROVAL]);
  });
});

/**
 * Delivery idempotency, which the wire contract makes `eventId`'s job.
 *
 * THE FAILURE THIS PINS: Cloud retries a delivery that did not answer 202, and a
 * retry lands wherever the load balancer sends it. Remembered in one instance's
 * memory, the retry looks new to the instance holding it — and the person's text
 * runs a SECOND time, with a second tool call behind it.
 */
describe("the delivery log", () => {
  it("gives one delivery to exactly one caller, on any instance", async () => {
    const store = await freshStore();
    const log = new ChannelEventLog(store);

    expect(await log.claim("evt_1", "conv_1")).toBe(true);
    expect(await log.claim("evt_1", "conv_1")).toBe(false);
    expect(await new ChannelEventLog(store).claim("evt_1", "conv_1")).toBe(false);
    expect(await log.claim("evt_2", "conv_1")).toBe(true);
  });

  it("keeps a vendor's event id out of the row id, so two ids never collide", async () => {
    const store = await freshStore();
    const log = new ChannelEventLog(store);

    // Two ids a naive sanitize would fold onto one row — the second text would
    // then be swallowed as a retry of the first and never answered.
    expect(await log.claim("evt/1", "conv_1")).toBe(true);
    expect(await log.claim("evt_1", "conv_1")).toBe(true);
  });

  it("forgets deliveries older than a day and keeps the ones inside it", async () => {
    const store = await freshStore();
    const log = new ChannelEventLog(store);
    expect(await log.claim("evt_old", "conv_1")).toBe(true);

    at(25 * 60 * 60_000);
    expect(await log.claim("evt_new", "conv_1")).toBe(true);

    // The old row was pruned by that claim, so its id is free again; the fresh
    // one is still remembered, because a retry can still be in flight.
    expect(await log.claim("evt_old", "conv_1")).toBe(true);
    expect(await log.claim("evt_new", "conv_1")).toBe(false);
  });
});
