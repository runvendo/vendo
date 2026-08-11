import { engineOverAdapter } from "@vendoai/core";
import type { RunContext } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SLOTS_COLLECTION, SLOT_DECAY_MS, createSlotRegistry } from "../src/server/persistence/slots.js";
import { memoryStore } from "../src/server/testing/memory-store.js";

const ctxFor = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: "session_slots",
});

const ada = ctxFor("user_ada");
const mia = ctxFor("user_mia");

afterEach(() => {
  vi.useRealTimers();
});

describe("the slot registry — one row per (subject, slot)", () => {
  it("refreshes a re-reported slot in place instead of growing the registry", async () => {
    const store = memoryStore();
    const slots = createSlotRegistry(engineOverAdapter(store));
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    await slots.report({ slots: [{ id: "hero", label: "Homepage hero" }] }, ada);
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
    await slots.report({ slots: [{ id: "hero", label: "Homepage hero" }] }, ada);

    expect(await slots.list(ada)).toEqual([
      { id: "hero", label: "Homepage hero", lastSeen: "2026-08-03T00:00:00.000Z" },
    ]);
    // Every render of the page reports again, so a row per report would grow
    // without bound for as long as anyone keeps the tab open.
    expect((await store.records(SLOTS_COLLECTION).list()).records).toHaveLength(1);
  });

  it("updates a renamed label in place, and keeps two subjects' slots apart", async () => {
    const store = memoryStore();
    const slots = createSlotRegistry(engineOverAdapter(store));

    // One page mounts several slots and reports them together.
    await slots.report({
      slots: [{ id: "hero", label: "Hero" }, { id: "sidebar", label: "Sidebar" }],
    }, ada);
    await slots.report({ slots: [{ id: "hero", label: "Homepage hero" }] }, ada);
    // The same slot id under another subject is a different row entirely.
    await slots.report({ slots: [{ id: "hero", label: "Mia's hero" }] }, mia);

    expect((await slots.list(ada)).map(({ id, label }) => ({ id, label })))
      .toEqual(expect.arrayContaining([
        { id: "hero", label: "Homepage hero" },
        { id: "sidebar", label: "Sidebar" },
      ]));
    expect(await slots.list(ada)).toHaveLength(2);
    expect((await slots.list(mia)).map(({ label }) => label)).toEqual(["Mia's hero"]);
  });

  it("keys every row on the subject alone, which is what the erase cascade matches", async () => {
    const store = memoryStore();
    await createSlotRegistry(engineOverAdapter(store)).report({ slots: [{ id: "hero", label: "Hero" }] }, ada);

    const rows = await store.records(SLOTS_COLLECTION).list({ refs: { subject: "user_ada" } });
    expect(rows.records.map((record) => record.refs)).toEqual([{ subject: "user_ada" }]);
  });

  it("drops a slot last seen past the decay window and answers newest-seen first", async () => {
    const store = memoryStore();
    const slots = createSlotRegistry(engineOverAdapter(store));
    const now = Date.parse("2026-08-06T00:00:00.000Z");
    vi.useFakeTimers();

    vi.setSystemTime(now - SLOT_DECAY_MS - 60_000);
    await slots.report({ slots: [{ id: "retired", label: "Retired" }] }, ada);
    vi.setSystemTime(now - SLOT_DECAY_MS + 60_000);
    await slots.report({ slots: [{ id: "sidebar", label: "Sidebar" }] }, ada);
    vi.setSystemTime(now - 60_000);
    await slots.report({ slots: [{ id: "hero", label: "Hero" }] }, ada);
    vi.setSystemTime(now);

    expect((await slots.list(ada)).map(({ id }) => id)).toEqual(["hero", "sidebar"]);

    // The decay is a READ-side window over `lastSeen`, so rendering the retired
    // slot again brings it straight back — and back FIRST, though its row is
    // the oldest one here. The generic collection orders by created_at, which
    // would have answered the opposite.
    await slots.report({ slots: [{ id: "retired", label: "Retired" }] }, ada);
    expect((await slots.list(ada)).map(({ id }) => id)).toEqual(["retired", "hero", "sidebar"]);
  });
});
