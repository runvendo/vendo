import { VendoError } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import {
  assertPinsExportable,
  inClientApprovalSchema,
  pinApprovalSchema,
  pinBaselineSchema,
  pinShipRequestSchema,
} from "./pins.js";

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

  it("fails pin export when a matching baseline is missing or forbidden", () => {
    const pins = [{ slot: "invoice-card", base: "sha256:x" }];

    expect(() => assertPinsExportable(pins, [])).toThrow(
      new VendoError("blocked", "pin invoice-card is not exportable", {
        slot: "invoice-card",
        base: "sha256:x",
        reason: "missing-baseline",
      }),
    );
    expect(() => assertPinsExportable(pins, [{
      slot: "invoice-card",
      source: "source",
      hash: "sha256:x",
      exportable: false,
      capturedAt,
    }])).toThrow(
      new VendoError("blocked", "pin invoice-card is not exportable", {
        slot: "invoice-card",
        base: "sha256:x",
        reason: "baseline-forbids-export",
      }),
    );
  });

  it("allows every pin only when its slot baseline is exportable", () => {
    expect(() => assertPinsExportable(
      [{ slot: "invoice-card", base: "sha256:x" }],
      [{
        slot: "invoice-card",
        source: "source",
        hash: "sha256:x",
        exportable: true,
        capturedAt,
      }],
    )).not.toThrow();
  });
});
