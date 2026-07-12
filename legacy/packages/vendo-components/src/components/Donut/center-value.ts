import type { z } from "zod";
import type { donutSchema } from "./descriptor.js";

type Slice = z.infer<typeof donutSchema>["slices"][number];

/** Leading currency symbol (everything before the first digit/sign), if any. */
function currencyPrefix(display: string): string | null {
  const m = display.trim().match(/^([^\d\-.,\s]+)\s?/);
  return m ? m[1]! : null;
}

/** Parse the numeric magnitude out of a formatted money string ("$2,850.00" → 2850). */
function parseAmount(display: string): number | null {
  const cleaned = display.replace(/[^\d.-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function fractionDigits(display: string): number {
  const dot = display.replace(/[^\d.]/g, "").indexOf(".");
  if (dot === -1) return 0;
  return display.replace(/[^\d.]/g, "").length - dot - 1;
}

/**
 * The center total on a donut must equal the values it summarizes — a
 * separately model-authored `centerValue` can be independently wrong (a
 * cents-vs-dollars re-division showed "$40.18" over a legend summing to
 * "$4,017.81"). When every slice carries a consistently currency-formatted
 * `display`, derive the center from the SUM OF WHAT THE LEGEND SHOWS so the
 * two can never disagree. A non-currency centerValue (a percentage, a label)
 * is a deliberate different metric and is left untouched.
 */
export function resolveCenterValue(
  slices: Slice[],
  centerValue: string | undefined,
): string | undefined {
  const displays = slices.map((s) => s.display);
  if (!displays.every((d): d is string => typeof d === "string")) return centerValue;

  const prefixes = displays.map(currencyPrefix);
  const prefix = prefixes[0];
  if (!prefix || !prefixes.every((p) => p === prefix)) return centerValue;

  const amounts = displays.map(parseAmount);
  if (amounts.some((a) => a === null)) return centerValue;

  // Only override a centerValue that is itself money (the buggy case); leave a
  // percentage / free-text center as the model wrote it.
  if (centerValue !== undefined && currencyPrefix(centerValue) !== prefix) return centerValue;

  const total = (amounts as number[]).reduce((s, a) => s + a, 0);
  const decimals = Math.max(0, ...displays.map(fractionDigits));
  return (
    prefix +
    total.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  );
}
