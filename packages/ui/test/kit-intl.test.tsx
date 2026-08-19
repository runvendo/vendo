// @vitest-environment jsdom
// Currency and locale threading. `tools.json` semantics have carried `currency`
// since the enrich pass, but every Kit formatter hardcoded USD — so a Pakistani
// payments host rendered "$107.68" no matter what its host tools declared. This
// suite pins that a host's declared config reaches the pure formatters, and
// through them the figures the Kit still writes ITSELF.
//
// WHICH figures those are moved when the charts' `format` tokens died: a screen
// writes its own money now, so the ambient CURRENCY is the chrome's affair
// (`chrome/humanize.ts`) and nothing a Kit component renders reads it. What a
// chart still writes is the one figure a screen cannot reach — a scale's tick,
// and an unformatted value beside it — and that reads through the ambient
// LOCALE's digit grouping.
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  currencyMinorUnits,
  formatMoney,
  formatNum,
  getKitIntl,
  setKitIntl,
  BarChart,
} from "../src/kit/index.js";
import { VendoProvider, createVendoClient } from "../src/index.js";

/** jsdom lays nothing out, so recharts' ResponsiveContainer measures zero and
 *  draws no SVG at all (charts.test.tsx documents the same stub). */
function stubChartSize(width: number, height: number): () => void {
  const real = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb([{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry], this as never);
    }
    unobserve() {}
    disconnect() {}
  } as never;
  return () => {
    globalThis.ResizeObserver = real;
  };
}

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
    expect(formatMoney(1234.56)).toBe("$1,234.56");
  });

  it("formats in the configured currency", () => {
    setKitIntl({ currency: "PKR" });
    // The regression itself: PKR 107.68, never $107.68.
    expect(formatMoney(107.68)).toContain("107.68");
    expect(formatMoney(107.68)).not.toContain("$");
  });

  it("reaches formatNum — the path a chart's axis actually calls", () => {
    setKitIntl({ locale: "de-DE" });
    expect(formatNum(1_234_567)).toBe("1.234.567");
  });

  it("honours a zero-decimal currency's minor unit", () => {
    setKitIntl({ currency: "JPY" });
    // JPY has no minor unit, so whole yen show no decimals.
    expect(formatMoney(1234)).toContain("1,234");
    expect(formatMoney(1234)).not.toContain(".");
  });

  it("shows the ISO minor unit's decimals, not the locale's display preference", () => {
    // The portability bug: Chrome's CLDR wants 0 decimals for PKR, Node's
    // wants 2. Trusting that made the SAME amount render "PKR 107.68"
    // server-side and "PKR 108" in the browser.
    expect(currencyMinorUnits("PKR")).toBe(2);
    setKitIntl({ currency: "PKR" });
    expect(formatMoney(107.68)).toContain("107.68");
  });

  it("shows a three-decimal currency's third decimal", () => {
    expect(currencyMinorUnits("KWD")).toBe(3);
    setKitIntl({ currency: "KWD" });
    expect(formatMoney(10.768)).toContain("10.768");
  });

  it("defaults an unlisted currency to two minor units", () => {
    expect(currencyMinorUnits("gbp")).toBe(2);
  });

  it("lets a per-value currency override the ambient one", () => {
    setKitIntl({ currency: "PKR" });
    expect(formatMoney(107.68, { currency: "USD" })).toBe("$107.68");
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
    expect(formatMoney(107.68)).toBe("$107.68");
  });

  it("stays total when generation authors an invalid per-value currency", () => {
    // Reachable from the model, so it must placeholder rather than throw.
    expect(() => formatMoney(107.68, { currency: "not-a-currency" })).not.toThrow();
    expect(formatMoney(107.68, { currency: "not-a-currency" })).toBeNull();
  });
});

describe("VendoProvider intl", () => {
  it("installs the host currency before children render", () => {
    // Read during the CHILD's own render, which is the ordering that matters: a
    // figure formatted on the first pass has to already see the host's currency.
    let seen: string | undefined;
    function Probe() {
      seen = getKitIntl().currency;
      return null;
    }
    renderInProvider({ currency: "PKR" }, <Probe />);
    expect(seen).toBe("PKR");
  });

  // A chart's UNFORMATTED figure is the last one the Kit writes itself — the axis
  // scale and the bar label beside it — so it is the one place a host's declared
  // locale has to reach a RENDERED figure rather than a formatter somebody called
  // by hand. It is grouping and nothing else: the Kit never says what the number
  // MEANS, which is why no currency appears here whatever the host declares.
  it("drives a chart's own digit grouping", () => {
    const restore = stubChartSize(360, 220);
    try {
      const text = renderInProvider(
        { locale: "de-DE" },
        <BarChart data={[{ month: "Jan", amount: 285_000 }]} xKey="month" series={["amount"]} />,
      );
      expect(text).toContain("285.000");
    } finally {
      restore();
    }
  });

  it("falls back to en-US grouping when the host declares nothing", () => {
    const restore = stubChartSize(360, 220);
    try {
      const text = renderInProvider(
        undefined,
        <BarChart data={[{ month: "Jan", amount: 285_000 }]} xKey="month" series={["amount"]} />,
      );
      expect(text).toContain("285,000");
    } finally {
      restore();
    }
  });

  // And a screen's OWN money is the screen's: the chart prints what the function
  // returned, untouched by the host's declared currency, because the screen has
  // already said which one it meant.
  it("leaves a screen's own formatted figure exactly as the screen wrote it", () => {
    const restore = stubChartSize(360, 220);
    try {
      const text = renderInProvider(
        { currency: "PKR" },
        <BarChart
          data={[{ month: "Jan", amount_cents: 10_768 }]}
          xKey="month"
          series={[{ key: "amount_cents", format: (row) => `$${(Number(row.amount_cents) / 100).toFixed(2)}` }]}
        />,
      );
      expect(text).toContain("$107.68");
    } finally {
      restore();
    }
  });
});
