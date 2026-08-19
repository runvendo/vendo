import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelEventLog } from "../src/channel-links.js";

/**
 * WHOSE ROWS THE SWEEP ACTUALLY REACHES.
 *
 * The delivery log's prune used to run on every single message, re-listing and
 * re-deleting the whole conversation in front of a person waiting for a reply.
 * It is a sweep now — but a sweep on a single process-wide clock is a trap: one
 * chatty conversation consumes the interval and every other conversation's rows
 * are never considered again, which is a leak that grows for the life of a
 * long-lived deployment. The cadence is per conversation for that reason.
 *
 * Real store on both sides — the rows are written through the same records door
 * the claim writes through, and read back through the same one it reads.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

async function freshStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-channel-sweep-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.ensureSchema();
  return store;
}

const rows = (store: VendoStore, conversation: string): Promise<number> =>
  store.records("vendo_channel_events").list({ refs: { conversation } }).then((page) => page.records.length);

/** No wall-clock budget on purpose: the case's own timeout is the hang detector,
 *  and the sweep is now something a claim does NOT wait for, so its rows land
 *  shortly after the claim answers rather than before it. */
async function settlesTo(count: () => Promise<number>, expected: number): Promise<void> {
  while (await count() !== expected) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("the delivery log's sweep", () => {
  it("does not hold the claim while it deletes", async () => {
    // THE FAILURE THIS PINS: the sweep is a page read plus one delete per expired
    // row, and it ran INLINE inside the claim — so once an hour, per
    // conversation, the person whose text triggered it waited out seven serial
    // hosted round trips before their turn could even start.
    const store = await freshStore();
    const day = 24 * 60 * 60_000;
    for (const id of ["evt_a", "evt_b", "evt_c"]) {
      expect(await new ChannelEventLog(store).claim(id, "conv_block")).toBe(true);
    }

    // A fresh log, so the sweep cadence has not been spent, and two days on so
    // every row above is expired and the sweep has real work to do.
    vi.useFakeTimers({ now: Date.now() + 2 * day, toFake: ["Date"] });
    const log = new ChannelEventLog(store);

    // Deletes are HELD. A claim that still waits for the sweep never answers.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const records = store.records("vendo_channel_events");
    vi.spyOn(store, "records").mockImplementation((collection: string) => (
      collection !== "vendo_channel_events" ? store.records(collection)
        : { ...records, delete: async (id: string) => { await held; await records.delete(id); } }
    ));

    expect(await log.claim("evt_now", "conv_block")).toBe(true);

    release();
    // …and the sweep still lands: the work moved off the critical path, it did
    // not stop happening.
    await settlesTo(() => rows(store, "conv_block"), 1);
  }, 30_000);

  it("keeps its cadence per conversation, so a busy one cannot starve a quiet one", async () => {
    // THE FAILURE THIS PINS: with ONE process-wide sweep clock, the chatty
    // conversation below consumes the interval and the quiet one's expired rows
    // are never pruned again — they accumulate for the life of the process.
    const store = await freshStore();
    const log = new ChannelEventLog(store);
    const day = 24 * 60 * 60_000;

    // Both conversations take a delivery on day one.
    expect(await log.claim("evt_busy_1", "conv_busy")).toBe(true);
    expect(await log.claim("evt_quiet_1", "conv_quiet")).toBe(true);
    expect(await rows(store, "conv_quiet")).toBe(1);

    // Two days pass: every row above is now older than the retention window.
    vi.useFakeTimers({ now: Date.now() + 2 * day, toFake: ["Date"] });

    // The chatty conversation speaks first and sweeps itself. Awaited rather
    // than asserted outright: the claim no longer waits for its own sweep.
    expect(await log.claim("evt_busy_2", "conv_busy")).toBe(true);
    await settlesTo(() => rows(store, "conv_busy"), 1);

    // THE POINT: the quiet conversation's own next delivery must still sweep
    // ITS rows. On a shared clock the line above has already spent the
    // interval, and this row stays behind forever.
    expect(await log.claim("evt_quiet_2", "conv_quiet")).toBe(true);
    await settlesTo(() => rows(store, "conv_quiet"), 1);
  }, 30_000);

  it("still sweeps a conversation only once per interval, not once per message", async () => {
    // The other half of the bargain: the reason this became a sweep at all is
    // that a burst of texts must not each pay for a full list-and-delete pass.
    const store = await freshStore();
    const log = new ChannelEventLog(store);

    for (const id of ["evt_1", "evt_2", "evt_3", "evt_4"]) {
      expect(await log.claim(id, "conv_burst")).toBe(true);
    }
    let listed = 0;
    const records = store.records("vendo_channel_events");
    vi.spyOn(store, "records").mockImplementation((collection: string) => {
      if (collection !== "vendo_channel_events") return store.records(collection);
      return { ...records, list: async (query) => (listed += 1, records.list(query)) };
    });

    expect(await log.claim("evt_5", "conv_burst")).toBe(true);

    // The claim itself reads one row by id and writes one; it must not have
    // re-listed the conversation, because this conversation was swept moments
    // ago and the interval has not come round again.
    expect(listed).toBe(0);
  }, 30_000);
});
