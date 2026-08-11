import type {
  AppDocument,
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
  seedForkSource,
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

});

describe("seedForkSource", () => {
  it("keeps a source with a default export verbatim", () => {
    const declared = "export default function Card() { return null; }";
    expect(seedForkSource(declared)).toBe(declared);
    const aliased = "function Card() { return null; }\nexport { Card as default };";
    expect(seedForkSource(aliased)).toBe(aliased);
    const reExported = "export { default } from \"./card\";";
    expect(seedForkSource(reExported)).toBe(reExported);
  });

  it("ignores commented-out and quoted default exports", () => {
    const commented = "// export default function Old() {}\nexport function InvoiceCard() { return null; }";
    expect(seedForkSource(commented)).toBe(`${commented}\nexport { InvoiceCard as default };\n`);
    const block = "/* export default Old */\nexport function InvoiceCard() { return null; }";
    expect(seedForkSource(block)).toContain("export { InvoiceCard as default };");
    // A commented-out export is never the alias target either.
    const staleExport = "// export function OldCard() {}\nexport function InvoiceCard() { return null; }";
    expect(seedForkSource(staleExport)).toContain("export { InvoiceCard as default };");
    // A quoted phrase neither adds nor masks a real default export.
    const quoted = "const hint = \"export default\";\nexport function InvoiceCard() { return null; }\nexport default InvoiceCard;";
    expect(seedForkSource(quoted)).toBe(quoted);
  });

  it("ignores type-only default exports, which are erased at runtime", () => {
    const inline = "export function InvoiceCard() { return null; }\nexport { type Props as default };";
    expect(seedForkSource(inline)).toContain("export { InvoiceCard as default };");
    const statement = "export function InvoiceCard() { return null; }\nexport type { Props as default };";
    expect(seedForkSource(statement)).toContain("export { InvoiceCard as default };");
    const declared = "export default interface Props { label: string }\nexport function InvoiceCard() { return null; }";
    expect(seedForkSource(declared)).toContain("export { InvoiceCard as default };");
  });

  it("does not mistake a renamed default re-export for a default export", () => {
    // `export { default as InvoiceCard } from …` exposes only the NAMED
    // binding; there is no local binding to alias either, so the source passes
    // through unchanged and the seed gesture refuses it loudly.
    const renamed = "export { default as InvoiceCard } from \"./InvoiceCard\";";
    expect(seedForkSource(renamed)).toBe(renamed);
  });

  it("synthesizes a default export for a named function export (ENG-348)", () => {
    const source = "export function InvoiceCard() { return <b>invoices</b>; }";
    expect(seedForkSource(source)).toBe(`${source}\nexport { InvoiceCard as default };\n`);
  });

  it("synthesizes a default export for a named const export", () => {
    const source = "export const InvoiceCard = () => <b>invoices</b>;";
    expect(seedForkSource(source)).toBe(`${source}\nexport { InvoiceCard as default };\n`);
  });

  it("picks the component-cased export over helper exports", () => {
    const source = [
      "export const useInvoiceTotals = () => 0;",
      "export function InvoiceCard() { return null; }",
    ].join("\n");
    expect(seedForkSource(source)).toContain("export { InvoiceCard as default };");
  });

  it("aliases an export-list component back to its local binding", () => {
    const source = "function Internal() { return null; }\nexport { Internal as InvoiceCard };";
    expect(seedForkSource(source)).toContain("export { Internal as default };");
  });

  it("leaves a source with no detectable component export unchanged", () => {
    const local = "const Card = () => null;";
    expect(seedForkSource(local)).toBe(local);
    const lowercase = "export const helpers = { format: (value: number) => value };";
    expect(seedForkSource(lowercase)).toBe(lowercase);
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

  const app = (seed?: AppDocument["seed"]): AppDocument => ({
    format: "vendo/app@1",
    id: "app_drift",
    name: "Drift check",
    ...(seed === undefined ? {} : { seed }),
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
