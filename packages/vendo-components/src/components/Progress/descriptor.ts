import { z } from "zod";
import { prewired } from "../../descriptor";

export const progressSchema = z.object({
  /** What is being measured, e.g. "Dining budget". */
  label: z.string().optional(),
  value: z.number().min(0),
  /** The full-bar amount; defaults to 100 (value read as a percentage). */
  max: z.number().positive().optional(),
  /** Right-aligned display text, e.g. "$318 of $500". Model formats it. */
  display: z.string().optional(),
});

export const progressDescriptor = prewired(
  "Progress",
  "A horizontal progress/budget bar in the host brand: label, brand-accent fill " +
    "proportional to value/max (capped at full), and an optional display string " +
    "(e.g. '$318 of $500'). Use for budgets, limits, goals, and completion.",
  progressSchema,
);
