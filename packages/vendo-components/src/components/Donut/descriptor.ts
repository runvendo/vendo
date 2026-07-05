import { z } from "zod";
import { prewired } from "../../descriptor.js";

const hex = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);

export const donutSchema = z.object({
  slices: z
    .array(
      z.object({
        label: z.string(),
        value: z.number().positive(),
        /** Optional literal hex; omitted slices get a brand-accent ramp. */
        color: hex.optional(),
        /** Optional formatted value for the legend, e.g. "$2,850". */
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
  "A donut/ring chart with a legend and an optional centered total, drawn in a " +
    "brand-accent ramp (or per-slice hex colors). Use for part-of-whole breakdowns " +
    "like spending by category. Prefer a registered host donut when one exists.",
  donutSchema,
);
