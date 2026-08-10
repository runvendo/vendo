// RISK ROUND — the decay boundary, and what a row the server did not write does
// to the read. Both hold today; this pins them.
//
// The clock is the server's: `report` stamps `lastSeen` with its own
// `new Date().toISOString()` (slots.ts:70) and no caller-supplied time exists
// anywhere on this surface, so a client cannot backdate a slot into permanence
// or forward-date one out of the window.
import type { RunContext } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SLOTS_COLLECTION, SLOT_DECAY_MS, createSlotRegistry } from "../src/server/persistence/slots.js";
import { memoryStore } from "../src/server/testing/memory-store.js";

const ada: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_slots_risk",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("the decay window's edge and its junk rows", () => {
  it("keeps a slot last seen EXACTLY at the decay boundary", async () => {
    const store = memoryStore();
    const slots = createSlotRegistry(store);
    const now = Date.parse("2026-08-06T00:00:00.000Z");
    vi.useFakeTimers();

    vi.setSystemTime(now - SLOT_DECAY_MS);
    await slots.report({ slots: [{ id: "edge", label: "Edge" }] }, ada);
    vi.setSystemTime(now);

    // `>=` the floor, so the boundary itself is inside the window — one
    // millisecond older is not.
    expect((await slots.list(ada)).map(({ id }) => id)).toEqual(["edge"]);
    vi.setSystemTime(now + 1);
    expect(await slots.list(ada)).toEqual([]);
  });

  it("drops a row whose lastSeen is not a readable instant instead of answering with it", async () => {
    const store = memoryStore();
    const slots = createSlotRegistry(store);
    const rows = store.records(SLOTS_COLLECTION);

    await slots.report({ slots: [{ id: "real", label: "Real" }] }, ada);
    // Rows a hand, a migration, or another writer could leave behind. The read
    // is the only thing standing between them and the picker's destination
    // list, so an unreadable `lastSeen` must fail CLOSED, not sort as an
    // arbitrary string or crash the whole list.
    for (const [id, lastSeen] of [["junk", "not-a-date"], ["numeric", 12_345], ["missing", null]] as const) {
      await rows.put({ id: `slot:user_ada:${id}`, data: { id, label: id, lastSeen }, refs: { subject: "user_ada" } });
    }

    expect((await slots.list(ada)).map(({ id }) => id)).toEqual(["real"]);
  });
});
