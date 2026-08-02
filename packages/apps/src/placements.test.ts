// Remix final shape (2026-08-02) — pins/placements split. `pins` records fork
// provenance ONLY (drift, ship-diff, rebase); `placements` records "show this
// app in that slot" and feeds slot discovery ONLY. Stored legacy rows (the
// demo hosts' fake-hash pin workaround) classify on read and normalize on the
// next write; drift and ship-diff never see them.
import type { AppDocument, RunContext, StoreAdapter, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps, type PinBaseline } from "./index.js";
import { classifyLegacyPlacements, pinComponentName } from "./pins.js";
import { guardFixture, memoryStore, seedAppRow } from "./testing/index.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_placements" },
  venue: "app",
  presence: "present",
  sessionId: "session_placements",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

const SLOT = "net-worth-card";
const SOURCE = `export default function NetWorthCard() {
  return <strong>$1.2M</strong>;
}`;

const baseline: PinBaseline = {
  slot: SLOT,
  source: SOURCE,
  hash: "sha256:maple-base",
  exportable: false,
  capturedAt: "2026-07-14T12:00:00.000Z",
};

/** The pre-split demo workaround: a slot landing stored as a pin whose `base`
 *  is a fabricated content hash matching no captured baseline. */
const LEGACY_ROW = { slot: "home-hero", base: "sha256:fake-content-hash" };

const seedDoc = (id: string, overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: "vendo/app@1",
  id,
  name: "Legacy remix",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
  ...overrides,
});

const runtimeWith = (store: StoreAdapter) => createApps({
  store,
  guard: guardFixture(),
  tools,
  catalog: [],
  pinBaselines: [baseline],
});

describe("pins/placements split — legacy-row classification", () => {
  it("classifies a fake-hash entry as a placement and keeps real and drifted pins", () => {
    const classified = classifyLegacyPlacements(
      seedDoc("app_classify", { pins: [LEGACY_ROW, { slot: SLOT, base: "sha256:maple-base" }] }),
      [baseline],
    );
    expect(classified.pins).toEqual([{ slot: SLOT, base: "sha256:maple-base" }]);
    expect(classified.placements).toEqual(["home-hero"]);

    // A drifted fork (captured slot, superseded hash) is provenance the drift
    // and rebase surfaces must keep seeing — never a placement.
    const drifted = classifyLegacyPlacements(
      seedDoc("app_drifted", { pins: [{ slot: SLOT, base: "sha256:maple-old" }] }),
      [baseline],
    );
    expect(drifted.pins).toEqual([{ slot: SLOT, base: "sha256:maple-old" }]);
    expect(drifted.placements).toBeUndefined();

    // No baselines captured (unset or empty) — no signal to classify against;
    // fail closed and pass the document through untouched.
    const untouched = seedDoc("app_untouched", { pins: [LEGACY_ROW] });
    expect(classifyLegacyPlacements(untouched, undefined)).toBe(untouched);
    expect(classifyLegacyPlacements(untouched, [])).toBe(untouched);

    // An entry still carrying its forked component is provenance whose
    // baseline disappeared — never a placement, or captured host source would
    // launder past the export gate (assertPinsExportable fail-closed rule).
    const orphanedFork = seedDoc("app_orphaned", {
      pins: [{ slot: "gone-slot", base: "sha256:gone-base" }],
      components: { [pinComponentName("gone-slot")]: SOURCE },
    });
    expect(classifyLegacyPlacements(orphanedFork, [baseline])).toBe(orphanedFork);
  });

  it("reads a stored legacy row as a placement: slot discovery mounts it, drift stays quiet", async () => {
    const store = memoryStore();
    await seedAppRow(store, seedDoc("app_legacy", { pins: [LEGACY_ROW] }), ctx.principal.subject);
    const runtime = runtimeWith(store);

    // list() is what useSlotApp reads: the slot arrives in `placements`, and
    // `pins` no longer carries the fake-hash row (pins never place an app).
    const listed = await runtime.list(ctx);
    expect(listed.map(({ id }) => id)).toEqual(["app_legacy"]);
    expect(listed[0]?.placements).toEqual(["home-hero"]);
    expect(listed[0]?.pins).toBeUndefined();

    // The false drift warning the fake hash used to raise is gone.
    await expect(runtime.pins.drift("app_legacy", ctx)).resolves.toEqual([]);
  });

  it("normalizes the row on its next write: placements persist, the fake-hash pin does not", async () => {
    const store = memoryStore();
    await seedAppRow(store, seedDoc("app_norm", { pins: [LEGACY_ROW] }), ctx.principal.subject);
    const runtime = runtimeWith(store);

    // Any ordinary recorded write (here the deterministic gesture fork, which
    // also proves the edit path's concurrency check reads legacy rows
    // classified) persists the classified document.
    await runtime.pins.fork({ appId: "app_norm", slot: SLOT }, ctx);
    const stored = (await store.records("vendo_apps").get("app_norm"))?.data as { doc: AppDocument };
    expect(stored.doc.placements).toEqual(["home-hero"]);
    expect(stored.doc.pins).toEqual([{ slot: SLOT, base: "sha256:maple-base" }]);
  });

  it("keeps reporting real drift beside a classified placement", async () => {
    const store = memoryStore();
    await seedAppRow(
      store,
      seedDoc("app_drift", { pins: [LEGACY_ROW, { slot: SLOT, base: "sha256:maple-old" }] }),
      ctx.principal.subject,
    );
    const runtime = runtimeWith(store);
    await expect(runtime.pins.drift("app_drift", ctx)).resolves.toEqual([{
      slot: SLOT,
      component: pinComponentName(SLOT),
      baseHash: "sha256:maple-old",
      baselineHash: "sha256:maple-base",
      reason: "baseline-changed",
    }]);
  });

  it("ship-diff reviews fork provenance only — placements never enter the diff", async () => {
    const store = memoryStore();
    await seedAppRow(
      store,
      seedDoc("app_ship", { pins: [LEGACY_ROW, { slot: SLOT, base: "sha256:maple-base" }] }),
      ctx.principal.subject,
    );
    const runtime = runtimeWith(store);
    const diff = await runtime.inClient.shipDiff("app_ship", ctx);
    expect(diff.pins.map(({ slot }) => slot)).toEqual([SLOT]);
  });
});
