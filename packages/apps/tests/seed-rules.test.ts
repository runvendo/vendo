import type {
  AppDocument,
  SeedPort,
} from "../src/contract/index.js";
import { inClientApprovalSchema } from "../src/server/index.js";
import { describe, expect, it } from "vitest";
import {
  seedBaselineSchema,
  seedComponentName,
  type SeedBaseline,
} from "../src/server/index.js";
import {
  seedDrift,
} from "../src/contract/index.js";

const capturedAt = "2026-07-11T12:00:00.000Z";

describe("seed contract shapes", () => {
  it("validates the frozen baseline and in-client approval shapes", () => {
    expect(seedBaselineSchema.parse({
      slot: "invoice-card",
      source: "export function InvoiceCard() {}",
      hash: "sha256:x",
      exportable: true,
      capturedAt,
    })).toMatchObject({ slot: "invoice-card", exportable: true });
    expect(inClientApprovalSchema.parse({
      appId: "app_invoice",
      versionHash: "sha256:z",
      approvedBy: "user_admin",
      at: capturedAt,
    })).toMatchObject({ versionHash: "sha256:z" });
  });

  it("carries the splitter's ported half, and reads a baseline without one", () => {
    const captured = {
      slot: "invoice-card",
      source: "export function InvoiceCard() {}",
      hash: "sha256:x",
      exportable: true,
      capturedAt,
    };
    const ported: SeedPort = {
      source: "export default function InvoiceCard() { return <Card className=\"p-4\" />; }",
      tools: ["invoices_get"],
      holes: ["Sparkline"],
    };
    expect(seedBaselineSchema.parse({ ...captured, ported }).ported).toEqual(ported);
    expect(seedBaselineSchema.parse(captured).ported).toBeUndefined();
    expect(seedBaselineSchema.safeParse({
      ...captured,
      ported: { ...ported, tools: "invoices_get" },
    }).success).toBe(false);
  });

});

describe("seedDrift — one seed, one verdict", () => {
  const baseline = (slot: string, hash: string): SeedBaseline => ({
    slot,
    source: `export default function Card() { return null; } // ${hash}`,
    hash,
    exportable: false,
    capturedAt,
  });

  // Drift is a verdict about the BASELINE, so these cases say nothing about the
  // wish list — every seed carries one, and it is filled in here.
  const app = (seed?: Omit<NonNullable<AppDocument["seed"]>, "wishes">): AppDocument => ({
    format: "vendo/app@1",
    id: "app_drift",
    name: "Drift check",
    ...(seed === undefined ? {} : { seed: { ...seed, wishes: ["make it mine"] } }),
  });

  it("is silent on an unseeded app and on one still at its baseline", () => {
    expect(seedDrift(app(undefined), [baseline("invoice-card", "sha256:a")])).toBeNull();
    expect(seedDrift(
      app({ component: "invoice-card", baseline: "sha256:a" }),
      [baseline("invoice-card", "sha256:a")],
    )).toBeNull();
  });

  it("reports drift when the captured baseline hash changed", () => {
    expect(seedDrift(
      app({ component: "invoice-card", baseline: "sha256:old" }),
      [baseline("invoice-card", "sha256:new")],
    )).toEqual({
      component: "invoice-card",
      componentName: seedComponentName("invoice-card"),
      baseline: "sha256:old",
      current: "sha256:new",
      reason: "baseline-changed",
    });
  });

  it("reports a baseline that disappeared entirely as its own reason", () => {
    expect(seedDrift(app({ component: "invoice-card", baseline: "sha256:old" }), [])).toEqual({
      component: "invoice-card",
      componentName: seedComponentName("invoice-card"),
      baseline: "sha256:old",
      reason: "baseline-missing",
    });
  });

  it("ignores baselines for components this app was not seeded from", () => {
    expect(seedDrift(
      app({ component: "invoice-card", baseline: "sha256:a" }),
      [baseline("invoice-card", "sha256:a"), baseline("net-worth-card", "sha256:new")],
    )).toBeNull();
  });
});
