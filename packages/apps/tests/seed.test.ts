import { engineOverAdapter } from "@vendoai/core";
/**
 * Remix as a seeded app (06-apps §8).
 *
 * A remix is not a subsystem: it is a create that starts from something that
 * already existed. After the re-platform it is also not a COPY — the ✦ gesture
 * collects an instruction, records where the remix came from, and runs that
 * instruction through the ordinary edit door. What lands is an ordinary screen
 * app (`app.tsx`, the same artifact every other screen is), so there is no
 * captured host source in the document and nothing evaluates any.
 *
 * That single fact retires the two proofs this file used to carry — the island
 * gate's by-name exemption for a seeded seat, and the seat holding its own jail
 * furnishings. Both existed to make the host's own bytes runnable inside a
 * remix. Nothing runs them now, so what is asserted below is that nothing
 * carries them either.
 */
import {
  VENDO_APP_FORMAT,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import {
  SCREEN_FILE,
  seedDrift,
  type AppDocument,
  type SeedBaseline,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createApps, type AppsConfig, type AppsRuntime } from "../src/server/index.js";
import { scriptedScreenAssembler } from "../src/server/testing/screen-assembler.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel } from "../src/server/testing/scripted-model.js";
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
const SOURCE = `// Host provenance comment nothing may copy into the remix.
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

/** The ONE builder, as a fixture: it writes `app.tsx` and lands it through
 *  `authoredScreen`. The screen quotes the ask, so the person's own words are
 *  visible in the stored artifact. */
const askedScreen = (runtime: () => AppsRuntime, seen: string[] = []) =>
  scriptedScreenAssembler(runtime, (request) => {
    seen.push(request.request);
    return `export default function Screen() {\n  return <b>${request.request}</b>;\n}\n`;
  });

const runtimeWith = (store: ReturnType<typeof memoryStore>, overrides: Partial<AppsConfig> = {}) => createApps({
  store,
  guard: guardFixture(),
  tools,
  catalog: [],
  seedBaselines: [baseline()],
  ...overrides,
});

/** A runtime with the builder wired, and the asks it was handed. */
const buildingRuntime = (store: ReturnType<typeof memoryStore>, overrides: Partial<AppsConfig> = {}) => {
  const asked: string[] = [];
  let runtime: AppsRuntime;
  runtime = runtimeWith(store, {
    model: basicLanguageModel(),
    screen: askedScreen(() => runtime, asked),
    ...overrides,
  });
  return { runtime, asked };
};

// ---------------------------------------------------------------------------
// The ✦ gesture: an instruction, then an ordinary screen carrying provenance.
// ---------------------------------------------------------------------------

describe("seed.from — the ✦ gesture is a create that starts from something", () => {
  it("mints an ordinary screen app and records what was asked for", async () => {
    const { runtime, asked } = buildingRuntime(memoryStore());

    const app = await runtime.seed.from({ component: SLOT, instruction: "add a sparkline" }, owner);

    // Provenance is ONE record on the document, not a row set — and it now names
    // the instruction, because a re-seed replays it.
    expect(app.seed).toEqual({
      component: SLOT,
      baseline: "sha256:maple-base",
      instruction: "add a sparkline",
    });
    // The remix IS its screen: the ordinary artifact, through the ordinary door.
    expect(app.source?.[SCREEN_FILE]?.text).toContain("add a sparkline");
    expect(asked).toEqual(["add a sparkline"]);
    // And not one byte of the host's capture rode along — no seat, no bundle, no
    // jail furnishings.
    expect(app.components).toBeUndefined();
    expect(JSON.stringify(app)).not.toContain("Host provenance comment");
    expect(JSON.stringify(app)).not.toContain("rebeccapurple");
  });

  it("refuses a component the host never captured", async () => {
    const runtime = runtimeWith(memoryStore());
    await expect(runtime.seed.from({ component: "never-synced", instruction: "add a sparkline" }, owner))
      .rejects.toThrow(/no captured baseline/);
  });
});

// ---------------------------------------------------------------------------
// Drift is a WARNING. Never automatic.
// ---------------------------------------------------------------------------

describe("seed drift — a warning, never an action", () => {
  it("reports drift when the host component moves on, and nothing changes on its own", async () => {
    const store = memoryStore();
    const app = await buildingRuntime(store).runtime.seed.from(
      { component: SLOT, instruction: "add a sparkline" },
      owner,
    );

    // The host re-syncs: same slot, new capture.
    const resynced = runtimeWith(store, { seedBaselines: [baseline("sha256:maple-NEW")] });
    const drift = await resynced.seed.drift(app.id, owner);
    expect(drift).toMatchObject({
      component: SLOT,
      baseline: "sha256:maple-base",
      current: "sha256:maple-NEW",
      reason: "baseline-changed",
    });

    // Reporting drift did not touch the app: the person's remix is untouched
    // until they ask for the update.
    const after = await resynced.get(app.id, owner);
    expect(after?.seed?.baseline).toBe("sha256:maple-base");
    expect(after?.source?.[SCREEN_FILE]?.text).toContain("add a sparkline");
  });

  it("is silent on an app with no seed, and on one still at its baseline", async () => {
    const store = memoryStore();
    const app = await buildingRuntime(store).runtime.seed.from(
      { component: SLOT, instruction: "add a sparkline" },
      owner,
    );
    expect(await runtimeWith(store).seed.drift(app.id, owner)).toBeNull();

    const plain: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_plain",
      name: "Authored",
      ui: "tree",
    };
    expect(seedDrift(plain, [baseline("sha256:whatever")])).toBeNull();
  });

  it("reports a missing baseline as its own reason", () => {
    const doc: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_seeded",
      name: "Seeded",
      ui: "tree",
      seed: { component: SLOT, baseline: "sha256:gone", instruction: "add a sparkline" },
    };
    expect(seedDrift(doc, [])).toMatchObject({ reason: "baseline-missing" });
    expect(seedDrift(doc, [])?.current).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The re-seed: the host shipped a new version, so run the recorded ask again.
// ---------------------------------------------------------------------------

describe("seed.reseed — the recorded instruction, replayed on the new baseline", () => {
  it("re-runs the ask the remix was made with and mints a version", async () => {
    const store = memoryStore();
    const app = await buildingRuntime(store).runtime.seed.from(
      { component: SLOT, instruction: "add a sparkline" },
      owner,
    );

    const updated: SeedBaseline = {
      ...baseline("sha256:maple-NEW"),
      source: "export default function NetWorthCard() { return <strong>$1.4M</strong>; }",
    };
    const { runtime: resynced, asked } = buildingRuntime(store, { seedBaselines: [updated] });

    const reseeded = await resynced.seed.reseed({ appId: app.id }, owner);

    // The provenance moved, the instruction did not, and the builder ran it.
    expect(reseeded.seed).toEqual({
      component: SLOT,
      baseline: "sha256:maple-NEW",
      instruction: "add a sparkline",
    });
    expect(asked).toEqual(["add a sparkline"]);
    // The warning is gone because the app is now AT the current baseline.
    expect(await resynced.seed.drift(app.id, owner)).toBeNull();
    // It is an ordinary version in the ordinary history.
    const versions = await resynced.history(app.id, owner).list();
    expect(versions.some(({ intent }) => /Update .* to the host's current version/.test(intent))).toBe(true);
  });

  it("leaves the baseline where it was when the replay does not land", async () => {
    const store = memoryStore();
    const app = await buildingRuntime(store).runtime.seed.from(
      { component: SLOT, instruction: "add a sparkline" },
      owner,
    );

    // The host shipped a new version and the replay REFUSES. The edit door
    // reports that in `failure` rather than throwing, so rebasing the baseline
    // ahead of the replay left the OLD screen reading as the host's current
    // version — silently, with a 200 and no drift warning.
    const resynced = runtimeWith(store, {
      model: basicLanguageModel(),
      seedBaselines: [baseline("sha256:maple-NEW")],
      screen: { assemble: async () => ({ kind: "unavailable", why: "I could not write that change" }) },
    });

    const answer = await resynced.seed.reseed({ appId: app.id }, owner);

    expect(answer.seed?.baseline).toBe("sha256:maple-base");
    const stored = await resynced.get(app.id, owner);
    expect(stored?.seed?.baseline).toBe("sha256:maple-base");
    expect(stored?.source?.[SCREEN_FILE]?.text).toContain("add a sparkline");
    // So the warning still stands — and the retry is not refused as a conflict
    // against a baseline this remix never actually reached.
    expect(await resynced.seed.drift(app.id, owner)).toMatchObject({ reason: "baseline-changed" });
    const versions = await resynced.history(app.id, owner).list();
    expect(versions.some(({ intent }) => /host's current version/.test(intent))).toBe(false);
  });

  it("refuses a re-seed that would change nothing, and one on an unseeded app", async () => {
    const store = memoryStore();
    const { runtime } = buildingRuntime(store);
    const app = await runtime.seed.from({ component: SLOT, instruction: "add a sparkline" }, owner);
    await expect(runtime.seed.reseed({ appId: app.id }, owner)).rejects.toThrow(/has not changed/);

    const plain: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_unseeded",
      name: "Authored",
      ui: "tree",
    };
    await seedAppRow(engineOverAdapter(store), plain, owner.principal.subject);
    await expect(runtime.seed.reseed({ appId: plain.id }, owner))
      .rejects.toThrow(/was not created from a host component/);
  });
});

describe("seed.from is idempotent per (subject, component)", () => {
  it("a double tap returns the SAME app instead of minting a second", async () => {
    const store = memoryStore();
    const { runtime } = buildingRuntime(store);

    const first = await runtime.seed.from({ component: SLOT, instruction: "add a sparkline" }, owner);
    const second = await runtime.seed.from({ component: SLOT, instruction: "add a sparkline" }, owner);

    expect(second.id).toBe(first.id);
    expect((await runtime.list(owner)).filter(({ seed }) => seed?.component === SLOT)).toHaveLength(1);
  });
});
