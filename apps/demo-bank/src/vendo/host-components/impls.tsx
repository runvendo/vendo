/**
 * React adapters binding Maple's REAL components to their registered
 * descriptors. Compiled into the sandbox bundle (vendo-sandbox/entry.ts) —
 * never imported by the Next app itself.
 *
 * The adapter is where host-world inputs get translated for the sandbox:
 * Maple's `--color-ink` var doesn't exist in the iframe, so the sparkline
 * stroke maps to the injected `--vendo-fg` token.
 */
import { bindHostImpl } from "@vendoai/components";
import { Sparkline } from "@/components/charts/sparkline";
import { Donut } from "@/components/charts/donut";
import { sparklineDescriptor, spendingDonutDescriptor } from "./descriptors";
import type { SpendingSlice } from "@/server/types";

const MapleSparkline = bindHostImpl(sparklineDescriptor, (p) => (
  <div style={{ height: p.height ?? 28 }}>
    <Sparkline data={p.data} height={p.height ?? 28} stroke="var(--vendo-fg, #14151A)" />
  </div>
));

const MapleSpendingDonut = bindHostImpl(spendingDonutDescriptor, (p) => (
  <Donut data={p.slices as SpendingSlice[]} size={p.size ?? 200} />
));

export const mapleHostImpls = {
  MapleSparkline,
  MapleSpendingDonut,
};
