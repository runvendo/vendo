import { describe, expect, it } from "vitest";
import {
  inClientApprovalSchema,
  pinApprovalSchema,
  pinBaselineSchema,
  pinShipRequestSchema,
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
