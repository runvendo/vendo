// @vitest-environment jsdom
// Currency threading. `tools.json` semantics have carried `currency` since the
// enrich pass, but every Kit formatter hardcoded USD — so a Pakistani payments
// host rendered "$107.68" in a generated DataTable no matter what its host
// tools declared. This suite pins that a host's declared currency reaches BOTH
// the pure formatters (which is what `format:"money"` columns, Stat, CardList
// and every chart call) and the Kit components, and that a per-value currency
// still overrides it.
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyFormat,
  currencyMinorUnits,
  formatMoney,
  getKitIntl,
  setKitIntl,
  DataTable,
  Money,
  Stat,
} from "../src/kit/index.js";
import { VendoProvider, createVendoClient } from "../src/index.js";

// The ambient default is process-wide; leaving it set would leak into every
// other suite in this file's worker.
afterEach(() => setKitIntl(undefined));

function renderInProvider(intl: { currency?: string; locale?: string } | undefined, node: React.ReactNode): string {
  const client = createVendoClient({ baseUrl: "http://vendo.test/api/vendo" });
  const { container } = render(
    <VendoProvider client={client} intl={intl}>
      {node}
    </VendoProvider>,
  );
  return container.textContent ?? "";
}

describe("ambient Kit intl", () => {
  it("defaults to USD so existing hosts are unchanged", () => {
    expect(getKitIntl()).toEqual({ currency: "USD", locale: "en-US" });
    expect(formatMoney(123456)).toBe("$1,234.56");
  });

  it("formats in the configured currency", () => {
    setKitIntl({ currency: "PKR" });
    // The regression itself: PKR 107.68, never $107.68.
    expect(formatMoney(10768)).toContain("107.68");
    expect(formatMoney(10768)).not.toContain("$");
  });

  it("reaches applyFormat — the path DataTable/Stat/charts actually call", () => {
    setKitIntl({ currency: "PKR" });
    expect(applyFormat(10768, "money")).not.toContain("$");
  });

  it("honours a zero-decimal currency's minor unit", () => {
    setKitIntl({ currency: "JPY" });
    // JPY has no minor unit, so 1234 is ¥1,234 — not ¥12.34.
    expect(formatMoney(1234)).toContain("1,234");
  });

  it("scales by the ISO minor unit, not the locale's display preference", () => {
    // The portability bug: Chrome's CLDR wants 0 decimals for PKR, Node's
    // wants 2. Trusting that made the SAME paisa amount render "PKR 107.68"
    // server-side and "PKR 10,768" in the browser.
    expect(currencyMinorUnits("PKR")).toBe(2);
    setKitIntl({ currency: "PKR" });
    expect(formatMoney(10768)).toContain("107.68");
    expect(formatMoney(10768)).not.toContain("10,768");
  });

  it("scales a three-decimal currency by 1000", () => {
    expect(currencyMinorUnits("KWD")).toBe(3);
    setKitIntl({ currency: "KWD" });
    expect(formatMoney(10768)).toContain("10.768");
  });

  it("defaults an unlisted currency to two minor units", () => {
    expect(currencyMinorUnits("gbp")).toBe(2);
  });

  it("lets a per-value currency override the ambient one", () => {
    setKitIntl({ currency: "PKR" });
    expect(formatMoney(10768, { currency: "USD" })).toBe("$107.68");
  });

  it("resets unspecified fields instead of merging with the previous call", () => {
    setKitIntl({ currency: "PKR", locale: "en-PK" });
    setKitIntl({ currency: "EUR" });
    expect(getKitIntl()).toEqual({ currency: "EUR", locale: "en-US" });
  });

  it("drops a host-config currency Intl rejects, keeping amounts readable", () => {
    setKitIntl({ currency: "not-a-currency" });
    // A typo costs the currency, never the whole view.
    expect(getKitIntl().currency).toBe("USD");
    expect(formatMoney(10768)).toBe("$107.68");
  });

  it("stays total when generation authors an invalid per-value currency", () => {
    // Reachable from the model, so it must placeholder rather than throw.
    expect(() => formatMoney(10768, { currency: "not-a-currency" })).not.toThrow();
    expect(formatMoney(10768, { currency: "not-a-currency" })).toBeNull();
  });
});

describe("VendoProvider intl", () => {
  it("installs the host currency before children render", () => {
    const text = renderInProvider({ currency: "PKR" }, <Money cents={10768} />);
    expect(text).toContain("107.68");
    expect(text).not.toContain("$");
  });

  it("drives a generated format:\"money\" DataTable column", () => {
    const text = renderInProvider(
      { currency: "PKR" },
      <DataTable
        rows={[{ amount: 10768 }]}
        columns={[{ key: "amount", label: "Amount", format: "money" }]}
      />,
    );
    expect(text).toContain("107.68");
    expect(text).not.toContain("$");
  });

  it("drives a format=\"money\" Stat", () => {
    const text = renderInProvider({ currency: "PKR" }, <Stat label="Total" value={29792} format="money" />);
    expect(text).not.toContain("$");
  });

  it("falls back to USD when the host declares nothing", () => {
    expect(renderInProvider(undefined, <Money cents={123456} />)).toContain("$1,234.56");
  });
});
