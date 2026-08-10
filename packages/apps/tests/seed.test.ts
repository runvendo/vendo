/**
 * Remix as a seeded app (06-apps §8).
 *
 * A remix is not a subsystem: it is a create that starts from something that
 * already existed. These tests hold the three things that were true only by
 * accident before, and the two that were outright broken.
 *
 * The two that were broken have their own proofs below, and each one is written
 * so that putting the old code back turns the assertion around:
 *
 *  1. SEEDED BUNDLES FACE ADMISSION. The checking floor used to filter seeded
 *     components out of the island gate entirely, on the grounds that captured
 *     host source is not a model island. That meant a capture the jail could
 *     never render was admitted without complaint. Restore the filter and the
 *     bad document below is admitted.
 *
 *  2. THE SEAT HOLDS ITS OWN CONTENTS. The jail furnishings used to be
 *     hash-matched against the live host baseline at open time, so the moment
 *     the host component changed, the match failed and a seeded app opened with
 *     no imports, no sub-modules and no styles — silently, with nothing on the
 *     payload to say anything was missing. Now they live in the stored bundle.
 */
import {
  VENDO_APP_FORMAT,
  seedComponentName,
  type RunContext,
  type ShapeType,
  type ToolRegistry,
} from "@vendoai/core";
import {
  hasDefaultExport,
  seedDrift,
  seedForkSource,
  isSeedComponentName,
  type AppDocument,
  type NormalizedCatalog,
  type SeedBaseline,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createApps, type AppsConfig } from "../src/server/index.js";
import { createCheckingLayer } from "../src/server/checking/layer.js";
import { floorChecks } from "../src/server/checking/floor.js";
import type { FloorDependencies } from "../src/server/checking/deps.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { scriptedLanguageModel } from "../src/server/testing/scripted-model.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";

const owner: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no fixture tools" } }; },
};

const SLOT = "net-worth-card";
const COMPONENT = seedComponentName(SLOT);
const SOURCE = `// Host provenance comment the seeded copy must carry.
export default function NetWorthCard() {
  return <strong>$1.2M</strong>;
}`;

const baseline = (hash = "sha256:maple-base"): SeedBaseline => ({
  slot: SLOT,
  source: SOURCE,
  hash,
  exportable: false,
  capturedAt: "2026-07-14T12:00:00.000Z",
  sourceImports: { "./format-currency": "src/format-currency.ts" },
  subSources: { "src/format-currency.ts": { source: "export const money = 1;", imports: {} } },
  sampleProps: { valueCents: 120_000_000 },
  styles: [{ path: "src/app.css", css: ".host { color: rebeccapurple; }" }],
});

const runtimeWith = (store: ReturnType<typeof memoryStore>, overrides: Partial<AppsConfig> = {}) => createApps({
  store,
  guard: guardFixture(),
  tools,
  catalog: [],
  seedBaselines: [baseline()],
  ...overrides,
});

// ---------------------------------------------------------------------------
// The ✦ gesture: capture → bundle → an ordinary create carrying a seed.
// ---------------------------------------------------------------------------

describe("seed.from — the ✦ gesture is a create that starts from something", () => {
  it("mints an ordinary app with NO model call, and the seat holds its own contents", async () => {
    const store = memoryStore();
    // No model configured at all: the gesture is deterministic and must not need one.
    const runtime = runtimeWith(store);

    const app = await runtime.seed.from({ component: SLOT }, owner);

    // Provenance is ONE record on the document, not a row set.
    expect(app.seed).toEqual({ component: SLOT, baseline: "sha256:maple-base" });
    // The TRUSTED captured source lands verbatim, comments included…
    const entry = app.components?.[COMPONENT];
    expect(typeof entry).toBe("object");
    expect((entry as { source: string }).source).toBe(SOURCE);
    // …tagged as seeded, and carrying every furnishing the jail needs to run it.
    expect((entry as { origin: string }).origin).toBe("seeded");
    expect((entry as { sourceImports?: unknown }).sourceImports)
      .toEqual({ "./format-currency": "src/format-currency.ts" });
    expect((entry as { subSources?: unknown }).subSources).toBeDefined();
    expect((entry as { styleSheets?: unknown }).styleSheets)
      .toEqual([{ path: "src/app.css", css: ".host { color: rebeccapurple; }" }]);
  });

  it("refuses a component the host never captured", async () => {
    const runtime = runtimeWith(memoryStore());
    await expect(runtime.seed.from({ component: "never-synced" }, owner))
      .rejects.toThrow(/no captured baseline/);
  });
});

// ---------------------------------------------------------------------------
// Drift is a WARNING. Never automatic.
// ---------------------------------------------------------------------------

describe("seed drift — a warning, never an action", () => {
  it("reports drift when the host component moves on, and nothing changes on its own", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store);
    const app = await runtime.seed.from({ component: SLOT }, owner);

    // The host re-syncs: same slot, new capture.
    const resynced = runtimeWith(store, { seedBaselines: [baseline("sha256:maple-NEW")] });
    const drift = await resynced.seed.drift(app.id, owner);
    expect(drift).toMatchObject({
      component: SLOT,
      componentName: COMPONENT,
      baseline: "sha256:maple-base",
      current: "sha256:maple-NEW",
      reason: "baseline-changed",
    });

    // Reporting drift did not touch the app: the person's copy is untouched
    // until they ask for the update.
    const after = await resynced.get(app.id, owner);
    expect(after?.seed?.baseline).toBe("sha256:maple-base");
  });

  it("is silent on an app with no seed, and on one still at its baseline", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store);
    const app = await runtime.seed.from({ component: SLOT }, owner);
    expect(await runtime.seed.drift(app.id, owner)).toBeNull();

    const plain: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_plain",
      name: "Authored",
      ui: "tree",
      tree: { formatVersion: "vendo-genui/v2", root: "root", nodes: [{ id: "root", component: "Stack", source: "prewired" }] },
    };
    expect(seedDrift(plain, [baseline("sha256:whatever")])).toBeNull();
  });

  it("reports a missing baseline as its own reason", () => {
    const doc: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_seeded",
      name: "Seeded",
      ui: "tree",
      tree: { formatVersion: "vendo-genui/v2", root: "root", nodes: [{ id: "root", component: "Stack", source: "prewired" }] },
      seed: { component: SLOT, baseline: "sha256:gone" },
    };
    expect(seedDrift(doc, [])).toMatchObject({ reason: "baseline-missing" });
    expect(seedDrift(doc, [])?.current).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// d6 — the plain re-seed. It REPLACES. That is the whole trade.
// ---------------------------------------------------------------------------

describe("seed.reseed — a plain swap for the pristine new component", () => {
  it("replaces the seeded component and mints a version", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store);
    const app = await runtime.seed.from({ component: SLOT }, owner);

    const NEW_SOURCE = "export default function NetWorthCard() { return <strong>$1.4M</strong>; }";
    const updated: SeedBaseline = { ...baseline("sha256:maple-NEW"), source: NEW_SOURCE };
    const resynced = runtimeWith(store, {
      seedBaselines: [updated],
      model: scriptedLanguageModel(() => "<Edit></Edit>"),
    });

    const reseeded = await resynced.seed.reseed({ appId: app.id }, owner);

    expect(reseeded.seed?.baseline).toBe("sha256:maple-NEW");
    expect((reseeded.components?.[COMPONENT] as { source: string }).source).toBe(NEW_SOURCE);
    // The warning is gone because the app is now AT the current baseline.
    expect(await resynced.seed.drift(app.id, owner)).toBeNull();
    // It is an ordinary version in the ordinary history.
    const versions = await resynced.history(app.id, owner).list();
    expect(versions.some(({ intent }) => /Update .* to the host's current version/.test(intent))).toBe(true);
  });

  it("refuses a re-seed that would change nothing, and one on an unseeded app", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store);
    const app = await runtime.seed.from({ component: SLOT }, owner);
    await expect(runtime.seed.reseed({ appId: app.id }, owner)).rejects.toThrow(/has not changed/);

    const plain: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_unseeded",
      name: "Authored",
      ui: "tree",
      tree: { formatVersion: "vendo-genui/v2", root: "root", nodes: [{ id: "root", component: "Stack", source: "prewired" }] },
    };
    await seedAppRow(store, plain, owner.principal.subject);
    await expect(runtime.seed.reseed({ appId: plain.id }, owner))
      .rejects.toThrow(/was not created from a host component/);
  });
});

// ===========================================================================
// PROOF 1 — the admission skip is GONE, not merely deleted.
//
// The floor used to drop every seeded component before the island gate ran:
//
//     .filter(([name]) => !isSeedComponentName(name))
//
// Put that line back in `server/checking/floor.ts` and this test goes GREEN in
// the wrong direction: the findings list comes back empty and the bad document
// below is admitted. That is the whole reason this is written as a refusal and
// not as a happy path.
// ===========================================================================

const floorDeps = (): FloorDependencies => ({
  model: scriptedLanguageModel(() => '<App name="unused"/>'),
  catalog: [] as NormalizedCatalog,
  tools: [],
  toolShapes: {} as Record<string, ShapeType>,
});

/** A seeded seat whose source the jail could never render: no default export,
 *  which is the component-bundle rule every island has to satisfy. */
const BAD_SEEDED_SOURCE = "export const NetWorthCard = () => <strong>$1.2M</strong>;";

const seededDocument = (source: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_admission",
  name: "Seeded",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["seat"] },
      { id: "seat", component: COMPONENT, source: "generated" },
    ],
  },
  seed: { component: SLOT, baseline: "sha256:maple-base" },
  components: { [COMPONENT]: { source, origin: "seeded" } },
} as AppDocument);

describe("PROOF — a seeded bundle faces admission like anything else", () => {
  it("REFUSES a seeded bundle that violates a component-bundle rule", async () => {
    const deps = floorDeps();
    const layer = createCheckingLayer({ deps, checks: floorChecks(deps) });

    const findings = await layer.run({ document: seededDocument(BAD_SEEDED_SOURCE), request: "" });

    // The name really is a seeded one — so the old skip would really have
    // caught it, which is what makes this a proof rather than a coincidence.
    expect(isSeedComponentName(COMPONENT)).toBe(true);
    const blocks = findings.filter(({ severity }) => severity === "block");
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.map(({ message }) => message).join("\n")).toMatch(/export default/);
  });

  it("admits the same seat once its source satisfies the rule", async () => {
    const deps = floorDeps();
    const layer = createCheckingLayer({ deps, checks: floorChecks(deps) });

    const findings = await layer.run({ document: seededDocument(SOURCE), request: "" });

    expect(findings.filter(({ severity }) => severity === "block")).toEqual([]);
  });
});

// ===========================================================================
// PROOF 2 — the seat holds its own contents, drift or no drift.
//
// Asserted on the OPENED surface, not on the stored row: the stored row was
// never the thing that was broken. `attachPinFurnishings` matched the app's
// pin against a live baseline by hash, so a drifted app matched nothing and
// opened furnished with nothing.
// ===========================================================================

describe("PROOF — a drifted seeded app still opens with its full bundle", () => {
  it("keeps every furnishing when the host baseline has moved on", async () => {
    const store = memoryStore();
    const app = await runtimeWith(store).seed.from({ component: SLOT }, owner);

    // The host moves on. Under the old open-time hash match this is exactly the
    // moment the furnishings vanished.
    const resynced = runtimeWith(store, {
      seedBaselines: [{ ...baseline("sha256:maple-NEW"), source: "export default function X() { return <b>new</b>; }" }],
      model: scriptedLanguageModel(() => "<Edit></Edit>"),
    });

    // It really is drifted, or this proves nothing.
    expect(await resynced.seed.drift(app.id, owner)).not.toBeNull();

    const surface = await resynced.open(app.id, owner);
    if (surface.kind !== "tree") throw new Error("expected a tree surface");
    const payload = surface.payload as {
      furnishings?: Record<string, Record<string, unknown>>;
      seedDrift?: unknown;
    };
    const furnishing = payload.furnishings?.[COMPONENT];

    // The luggage is all still here, read off the document rather than matched
    // against a baseline that has moved.
    expect(furnishing).toBeDefined();
    expect(furnishing?.sourceImports).toEqual({ "./format-currency": "src/format-currency.ts" });
    expect(furnishing?.subSources).toEqual({ "src/format-currency.ts": { source: "export const money = 1;", imports: {} } });
    expect(furnishing?.styles).toEqual([{ path: "src/app.css", css: ".host { color: rebeccapurple; }" }]);
    expect(furnishing?.sampleProps).toEqual({ valueCents: 120_000_000 });
    // And the person is TOLD, on the same payload, rather than left with a
    // quietly broken render.
    expect(payload.seedDrift).toMatchObject({ component: SLOT, reason: "baseline-changed" });
    // The CDN door stays shut on this path (the venue wall) — nothing about
    // moving the luggage into the bundle opens it.
    expect(furnishing?.packages).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The pure rules that used to live in `remix/pins.ts`.
// ---------------------------------------------------------------------------

describe("seedForkSource — a named-export capture still renders", () => {
  it("passes a real default export through untouched", () => {
    expect(seedForkSource(SOURCE)).toBe(SOURCE);
    expect(hasDefaultExport(SOURCE)).toBe(true);
  });

  it("synthesizes the default export a named capture lacks", () => {
    const named = "export const InvoiceCard = () => <b>hi</b>;";
    expect(seedForkSource(named)).toBe(`${named}\nexport { InvoiceCard as default };\n`);
    expect(hasDefaultExport(seedForkSource(named))).toBe(true);
  });

  it("never matches an export that is only mentioned in a comment or a string", () => {
    const commented = "// export default function Nope() {}\nexport const InvoiceCard = () => <b>hi</b>;";
    expect(hasDefaultExport(commented)).toBe(false);
    expect(seedForkSource(commented)).toContain("export { InvoiceCard as default };");
  });

  it("leaves a source with nothing component-shaped to alias alone", () => {
    const lowercase = "export const helper = 1;";
    expect(seedForkSource(lowercase)).toBe(lowercase);
  });
});

describe("isSeedComponentName", () => {
  it("names a seeded seat and nothing else", () => {
    expect(isSeedComponentName(COMPONENT)).toBe(true);
    expect(isSeedComponentName("InvoiceCard")).toBe(false);
    expect(isSeedComponentName("PinnedNoHash")).toBe(false);
  });
});

describe("seed.from is idempotent per (subject, component)", () => {
  it("a double tap returns the SAME app instead of minting a second", async () => {
    const store = memoryStore();
    const runtime = runtimeWith(store);

    const first = await runtime.seed.from({ component: SLOT }, owner);
    const second = await runtime.seed.from({ component: SLOT }, owner);

    expect(second.id).toBe(first.id);
    expect((await runtime.list(owner)).filter(({ seed }) => seed?.component === SLOT)).toHaveLength(1);
  });
});
