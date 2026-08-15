// The reviewable ship-diff of a remix (06-apps §8–§9). A remix IS its screen
// now — there is no captured seat and no copy of the host source in the
// document — so the diff an approver reads is the person's own `app.tsx`
// against the host component it stands in for.
import {
  VENDO_APP_FORMAT,
} from "@vendoai/core";
import {
  SCREEN_FILE,
  type AppDocument,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { seedComponentName, type SeedBaseline } from "../src/contract/index.js";
import { computeShipDiff } from "../src/server/remix/ship-diff.js";
import { inlineSourceFile } from "../src/server/persistence/app-source.js";
import { appVersionHash } from "../src/server/remix/version-hash.js";

const baseline: SeedBaseline = {
  slot: "net-worth-card",
  source: "export default function Card() {\n  return <b>host</b>;\n}",
  hash: "sha256:baseline",
  exportable: true,
  capturedAt: "2026-07-14T12:00:00.000Z",
};

const componentName = seedComponentName("net-worth-card");

const SCREEN = "export default function Card() {\n  return <b>remixed</b>;\n}";

const app = (overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_ship_diff",
  name: "Ship diff",
  ui: "tree",
  seed: { component: "net-worth-card", baseline: "sha256:baseline", instruction: "say remixed" },
  source: { [SCREEN_FILE]: inlineSourceFile(SCREEN) },
  ...overrides,
});

describe("computeShipDiff", () => {
  it("pins the reviewed version by its content hash", () => {
    const doc = app();
    const shipDiff = computeShipDiff(doc, [baseline]);
    expect(shipDiff.appId).toBe(doc.id);
    expect(shipDiff.versionHash).toBe(appVersionHash(doc));
  });

  it("diffs the remix's own screen against the captured host baseline", () => {
    const shipDiff = computeShipDiff(app(), [baseline]);
    expect(shipDiff.pins).toHaveLength(1);
    const pin = shipDiff.pins[0]!;
    expect(pin).toMatchObject({
      slot: "net-worth-card",
      component: componentName,
      baseHash: "sha256:baseline",
      baselineHash: "sha256:baseline",
      drifted: false,
    });
    expect(pin.diff).toContain("-  return <b>host</b>;");
    expect(pin.diff).toContain("+  return <b>remixed</b>;");
    expect(shipDiff.generated).toEqual([]);
  });

  it("diffs against the LIVE capture, not the hash the seed recorded", () => {
    // The seed still says `sha256:baseline`, so the pin reads as drifted — but
    // the diff is against the source the host ships TODAY, which is the only
    // source an approver can be shown.
    const moved: SeedBaseline = {
      ...baseline,
      hash: "sha256:new-host-version",
      source: "export default function Card() {\n  return <b>host v2</b>;\n}",
    };
    const pin = computeShipDiff(app(), [moved]).pins[0]!;
    expect(pin.drifted).toBe(true);
    expect(pin.baselineHash).toBe("sha256:new-host-version");
    expect(pin.diff).toContain("-  return <b>host v2</b>;");
  });

  it("reports a remix whose screen is the host source verbatim as an empty diff", () => {
    const doc = app({ source: { [SCREEN_FILE]: inlineSourceFile(baseline.source) } });
    expect(computeShipDiff(doc, [baseline]).pins[0]?.diff).toBe("");
  });

  it("shows a remix with no screen yet as the host component being removed", () => {
    // The window between the ✦ mint and its first edit landing: nothing ships,
    // so what an approver sees is the baseline and nothing replacing it.
    const doc = app({ source: undefined });
    expect(computeShipDiff(doc, [baseline]).pins[0]?.diff).toContain("-  return <b>host</b>;");
  });

  it("flags a missing baseline as drifted and diffs from nothing, fail-closed", () => {
    const pin = computeShipDiff(app(), []).pins[0]!;
    expect(pin.drifted).toBe(true);
    expect(pin.baselineHash).toBeUndefined();
    expect(pin.diff).toContain("+  return <b>remixed</b>;");
    const deletions = pin.diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"));
    expect(deletions).toEqual([]);
  });

  it("reviews generated components as pure additions", () => {
    const doc = app({
      components: { FreshChart: "export default function FreshChart() {\n  return <svg />;\n}" },
    });
    const shipDiff = computeShipDiff(doc, [baseline]);
    expect(shipDiff.generated).toHaveLength(1);
    expect(shipDiff.generated[0]).toMatchObject({ component: "FreshChart" });
    expect(shipDiff.generated[0]?.diff).toContain("+export default function FreshChart() {");
  });

  it("changes the version hash for every content edit so re-approval is by construction", () => {
    const before = computeShipDiff(app(), [baseline]).versionHash;
    const after = computeShipDiff(app({ name: "Renamed" }), [baseline]).versionHash;
    expect(after).not.toBe(before);
  });
});
