import type { AppDocument } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import {
  detectPinDrift,
  inClientApprovalSchema,
  pinApprovalSchema,
  pinBaselineSchema,
  pinComponentName,
  pinShipRequestSchema,
  type PinBaseline,
} from "./index.js";

const capturedAt = "2026-07-11T12:00:00.000Z";

describe("pin contract shapes", () => {
  it("validates the frozen pin and in-client approval shapes", () => {
    expect(pinBaselineSchema.parse({
      slot: "invoice-card",
      source: "export function InvoiceCard() {}",
      hash: "sha256:x",
      exportable: true,
      capturedAt,
    })).toMatchObject({ slot: "invoice-card", exportable: true });
    expect(pinShipRequestSchema.parse({
      appId: "app_invoice",
      slot: "invoice-card",
      baseHash: "sha256:x",
      diff: "--- a\n+++ b",
    })).toMatchObject({ appId: "app_invoice", baseHash: "sha256:x" });
    expect(pinApprovalSchema.parse({
      slot: "invoice-card",
      baseHash: "sha256:x",
      approvedHash: "sha256:y",
      approvedBy: "user_admin",
      at: capturedAt,
    })).toMatchObject({ approvedHash: "sha256:y" });
    expect(inClientApprovalSchema.parse({
      appId: "app_invoice",
      versionHash: "sha256:z",
      approvedBy: "user_admin",
      at: capturedAt,
    })).toMatchObject({ versionHash: "sha256:z" });
  });

});

describe("detectPinDrift", () => {
  const baseline = (slot: string, hash: string): PinBaseline => ({
    slot,
    source: `export default function Card() { return null; } // ${hash}`,
    hash,
    exportable: false,
    capturedAt,
  });

  const app = (pins: AppDocument["pins"]): AppDocument => ({
    format: "vendo/app@1",
    id: "app_drift",
    name: "Drift check",
    ...(pins === undefined ? {} : { pins }),
  });

  it("reports nothing for matching baselines, pinless apps, and empty pins", () => {
    expect(detectPinDrift(app(undefined), [baseline("invoice-card", "sha256:a")])).toEqual([]);
    expect(detectPinDrift(app([]), [baseline("invoice-card", "sha256:a")])).toEqual([]);
    expect(detectPinDrift(
      app([{ slot: "invoice-card", base: "sha256:a" }]),
      [baseline("invoice-card", "sha256:a")],
    )).toEqual([]);
  });

  it("marks a pin drifted when the captured baseline hash changed", () => {
    expect(detectPinDrift(
      app([{ slot: "invoice-card", base: "sha256:old" }]),
      [baseline("invoice-card", "sha256:new")],
    )).toEqual([{
      slot: "invoice-card",
      component: pinComponentName("invoice-card"),
      baseHash: "sha256:old",
      baselineHash: "sha256:new",
      reason: "baseline-changed",
    }]);
  });

  it("marks a pin drifted when the baseline disappeared entirely", () => {
    expect(detectPinDrift(app([{ slot: "invoice-card", base: "sha256:old" }]), [])).toEqual([{
      slot: "invoice-card",
      component: pinComponentName("invoice-card"),
      baseHash: "sha256:old",
      reason: "baseline-missing",
    }]);
  });

  it("reports each pin independently", () => {
    expect(detectPinDrift(
      app([
        { slot: "invoice-card", base: "sha256:a" },
        { slot: "net-worth-card", base: "sha256:old" },
      ]),
      [baseline("invoice-card", "sha256:a"), baseline("net-worth-card", "sha256:new")],
    )).toEqual([expect.objectContaining({ slot: "net-worth-card", reason: "baseline-changed" })]);
  });
});
