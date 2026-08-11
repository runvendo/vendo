import { engineOverAdapter } from "@vendoai/core";
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
 *  1. A SEEDED SEAT SKIPS THE ISLAND GATE, BY NAME. The gate's rules are the
 *     generated-island contract, which captured host source cannot satisfy by
 *     construction — running it over a real capture blocks a remix the person
 *     can see on screen. Drop the filter and the real capture below is refused.
 *
 *  2. THE SEAT HOLDS ITS OWN CONTENTS. The jail furnishings used to be
 *     hash-matched against the live host baseline at open time, so the moment
 *     the host component changed, the match failed and a seeded app opened with
 *     no imports, no sub-modules and no styles — silently, with nothing on the
 *     payload to say anything was missing. Now they live in the stored bundle.
 */
import { readFileSync } from "node:fs";
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
    await seedAppRow(engineOverAdapter(store), plain, owner.principal.subject);
    await expect(runtime.seed.reseed({ appId: plain.id }, owner))
      .rejects.toThrow(/was not created from a host component/);
  });
});

// ===========================================================================
// PROOF 1 — a seeded seat is exempt from the island gate, BY NAME.
//
// This block used to be written the other way round: a seeded bundle with no
// default export was expected to come back blocked, and restoring the floor's
// `.filter(([name]) => !isSeedComponentName(name))` was called the regression.
// That was a proof of a premise that is false, and its fixture is why it looked
// true — three hand-typed lines that happen to obey the generated-island
// contract. The contract is written for source a MODEL wrote: no imports,
// ambient Kit only, no hand-typed constant feeding displayed math. Captured host
// source obeys none of it (the capture below blocks on `pad = 6`, SVG chart
// padding), and every block reaches the builder verbatim as a repair
// instruction — so on source the person did not write, the only edit that clears
// it is to stop rendering the remix.
//
// What is true is asserted below, against the capture the demo host actually
// ships rather than a toy: the seat is admitted, the SAME source under an
// ordinary name is still gated, and a capture the jail could not render is
// refused at the seed door itself.
// ===========================================================================

/** The host's own capture, read rather than retyped. */
const CAPTURE = (JSON.parse(
  readFileSync("../../examples/demo-bank/.vendo/remixable/NetWorthView.json", "utf8"),
) as SeedBaseline).source;

const floorDeps = (): FloorDependencies => ({
  model: scriptedLanguageModel(() => '<App name="unused"/>'),
  catalog: [] as NormalizedCatalog,
  tools: [],
  toolShapes: {} as Record<string, ShapeType>,
});

const documentWith = (name: string, source: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_admission",
  name: "Seeded",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["seat"] },
      { id: "seat", component: name, source: "generated" },
    ],
  },
  seed: { component: SLOT, baseline: "sha256:maple-base" },
  // Tagged `seeded` in BOTH cases, so the only difference between the two tests
  // below is the component's name.
  components: { [name]: { source, origin: "seeded" } },
} as AppDocument);

const blocksOn = async (document: AppDocument): Promise<string[]> => {
  const deps = floorDeps();
  const findings = await createCheckingLayer({ deps, checks: floorChecks(deps) }).run({ document, request: "" });
  return findings.filter(({ severity }) => severity === "block").map(({ message }) => message);
};

describe("PROOF — the island gate skips a seeded seat, and skips it by name", () => {
  it("admits a seat holding the host's real captured source", async () => {
    expect(isSeedComponentName(COMPONENT)).toBe(true);

    expect(await blocksOn(documentWith(COMPONENT, CAPTURE))).toEqual([]);
  });

  it("still gates the SAME source under a name that is not a seeded one", async () => {
    const blocks = await blocksOn(documentWith("Ordinary", CAPTURE));

    // The `origin: "seeded"` tag is identical in both documents: it is the name
    // that buys the exemption, and it has to be — a compiled `app.vendo` prints
    // its components as bare source strings, which all read back as `authored`.
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("refuses a capture the jail could never render at the seed door itself", async () => {
    const runtime = runtimeWith(memoryStore(), {
      seedBaselines: [{ ...baseline(), source: "export const total = 1;" }],
    });

    await expect(runtime.seed.from({ component: SLOT }, owner)).rejects.toThrow(/no default export/);
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
