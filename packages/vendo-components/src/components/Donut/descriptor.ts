import { z } from "zod";
import { prewired } from "../../descriptor.js";

const hex = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);

export const donutSchema = z.object({
  slices: z
    .array(
      z.object({
        label: z.string(),
        /** The final DISPLAY amount for this slice — already converted from any
         *  cents (e.g. 2850.00 for $2,850.00), NEVER raw cents (285000). Used
         *  for the ring proportions and to derive the centered total. */
        value: z.number().positive(),
        /** Optional literal hex; omitted slices get a brand-accent ramp. */
        color: hex.optional(),
        /** The formatted value shown in the legend AND summed for the center
         *  total, e.g. "$2,850.00". Provide it on money donuts so the center
         *  is derived from what the legend shows. */
        display: z.string().optional(),
      }),
    )
    .min(1)
    .max(10),
  /** Diameter in px (default 180). */
  size: z.number().min(120).max(320).optional(),
  /** Small muted label inside the ring, e.g. "Total". */
  centerLabel: z.string().optional(),
  /** Large value inside the ring, e.g. "$3,675". Model formats it. */
  centerValue: z.string().optional(),
  /** Show the legend (default true). */
  legend: z.boolean().optional(),
});

export const donutDescriptor = prewired(
  "Donut",
  "A donut/ring chart with a legend and an optional centered total. Each slice's " +
  "`value` is the final DISPLAY amount (already converted — never raw cents, e.g. " +
  "2850.00 not 285000); give every money slice a formatted `display` (\"$2,850.00\"). " +
  "The centered total is derived from the slices' displays — omit `centerValue` for a " +
  "sum (pass it only for a non-sum metric like \"62%\"), and never re-divide an " +
  "already-converted total. Drawn in a brand-accent ramp (or per-slice hex colors). " +
  "Use for part-of-whole breakdowns like spending by category. Prefer a registered " +
  "host donut when one exists.",
  donutSchema,
);
