import { VENDO_APP_FORMAT, type AppDocument } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { pinComponentName, pinForkSource, type PinBaseline } from "./pins.js";
import { computeShipDiff } from "./ship-diff.js";
import { appVersionHash } from "./version-hash.js";

const baseline: PinBaseline = {
  slot: "net-worth-card",
  source: "export default function Card() {\n  return <b>host</b>;\n}",
  hash: "sha256:baseline",
  exportable: true,
  capturedAt: "2026-07-14T12:00:00.000Z",
};

const componentName = pinComponentName("net-worth-card");

const app = (overrides: Partial<AppDocument> = {}): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_ship_diff",
  name: "Ship diff",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v1",
    root: "root",
    nodes: [{ id: "root", component: "Stack", source: "prewired" }],
  },
  pins: [{ slot: "net-worth-card", base: "sha256:baseline" }],
  components: {
    [componentName]: "export default function Card() {\n  return <b>forked</b>;\n}",
  },
  ...overrides,
});

describe("computeShipDiff", () => {
  it("pins the reviewed version by its content hash", () => {
    const doc = app();
    const shipDiff = computeShipDiff(doc, [baseline]);
    expect(shipDiff.appId).toBe(doc.id);
    expect(shipDiff.versionHash).toBe(appVersionHash(doc));
  });

  it("diffs a pinned fork against the captured host baseline", () => {
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
    expect(pin.diff).toContain("+  return <b>forked</b>;");
    expect(shipDiff.generated).toEqual([]);
  });

  it("reports an unchanged fork as an empty diff", () => {
    const doc = app({ components: { [componentName]: baseline.source } });
    expect(computeShipDiff(doc, [baseline]).pins[0]?.diff).toBe("");
  });

  it("reports an unedited fork of a named-export baseline as an empty diff (ENG-348)", () => {
    const named: PinBaseline = {
      ...baseline,
      source: "export function Card() {\n  return <b>host</b>;\n}",
    };
    // The fork ships pinForkSource(baseline.source) — the synthesized default
    // export is fork plumbing, not a host edit, so it never shows to approvers.
    const doc = app({ components: { [componentName]: pinForkSource(named.source) } });
    expect(computeShipDiff(doc, [named]).pins[0]?.diff).toBe("");
  });

  it("flags drift when the captured baseline hash no longer matches the pin base", () => {
    const moved: PinBaseline = { ...baseline, hash: "sha256:new-host-version" };
    const pin = computeShipDiff(app(), [moved]).pins[0]!;
    expect(pin.drifted).toBe(true);
    expect(pin.baselineHash).toBe("sha256:new-host-version");
  });

  it("flags a missing baseline as drifted and diffs from nothing, fail-closed", () => {
    const pin = computeShipDiff(app(), []).pins[0]!;
    expect(pin.drifted).toBe(true);
    expect(pin.baselineHash).toBeUndefined();
    expect(pin.diff).toContain("+  return <b>forked</b>;");
    const deletions = pin.diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"));
    expect(deletions).toEqual([]);
  });

  it("reviews non-pin generated components as pure additions", () => {
    const doc = app({
      components: {
        [componentName]: baseline.source,
        FreshChart: "export default function FreshChart() {\n  return <svg />;\n}",
      },
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
