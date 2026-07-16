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
import { pinForkSource } from "./pins.js";

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

describe("pinForkSource", () => {
  it("keeps a source with a default export verbatim", () => {
    const declared = "export default function Card() { return null; }";
    expect(pinForkSource(declared)).toBe(declared);
    const aliased = "function Card() { return null; }\nexport { Card as default };";
    expect(pinForkSource(aliased)).toBe(aliased);
    const reExported = "export { default } from \"./card\";";
    expect(pinForkSource(reExported)).toBe(reExported);
  });

  it("synthesizes a default export for a named function export (ENG-348)", () => {
    const source = "export function InvoiceCard() { return <b>invoices</b>; }";
    expect(pinForkSource(source)).toBe(`${source}\nexport { InvoiceCard as default };\n`);
  });

  it("synthesizes a default export for a named const export", () => {
    const source = "export const InvoiceCard = () => <b>invoices</b>;";
    expect(pinForkSource(source)).toBe(`${source}\nexport { InvoiceCard as default };\n`);
  });

  it("picks the component-cased export over helper exports", () => {
    const source = [
      "export const useInvoiceTotals = () => 0;",
      "export function InvoiceCard() { return null; }",
    ].join("\n");
    expect(pinForkSource(source)).toContain("export { InvoiceCard as default };");
  });

  it("aliases an export-list component back to its local binding", () => {
    const source = "function Internal() { return null; }\nexport { Internal as InvoiceCard };";
    expect(pinForkSource(source)).toContain("export { Internal as default };");
  });

  it("leaves a source with no detectable component export unchanged", () => {
    const local = "const Card = () => null;";
    expect(pinForkSource(local)).toBe(local);
    const lowercase = "export const helpers = { format: (value: number) => value };";
    expect(pinForkSource(lowercase)).toBe(lowercase);
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
