/**
 * Maple's registered host components — the app's OWN components, offered to
 * the agent (ENG-184/186 registration path).
 *
 * React-free on purpose: this module feeds BOTH the server (agent prompt +
 * registry validation) and the client provider. The React adapters live in
 * ./impls.tsx and are compiled into the sandbox bundle.
 *
 * The description strings are the docs the agent reads — write them like API
 * documentation: what it shows, when to reach for it, what the props mean.
 */
import { z } from "zod";
import { hostComponent, toHostRegistry } from "@flowlet/components/descriptors";

export const sparklineDescriptor = hostComponent(
  "MapleSparkline",
  "Maple's own tiny inline trend line (pure SVG, brand ink stroke). Use it for a " +
    "compact trend next to a stat — inside a Surface stat card under the value, or " +
    "in a table cell. Not for detailed analysis; it has no axes or labels. " +
    "`data` is the series in chronological order (2+ points).",
  z.object({
    data: z.array(z.number()).min(2).max(500),
    /** Optional CSS height (defaults to a compact 28px strip). */
    height: z.number().min(8).max(120).optional(),
  }),
);

export const spendingDonutDescriptor = hostComponent(
  "MapleSpendingDonut",
  "Maple's spending-by-category donut with the centered total — the exact component " +
    "the app's own Insights page uses, in Maple's muted category palette. Prefer this " +
    "over a generic pie chart for spending breakdowns. `slices` take a category id " +
    "(one of: dining, groceries, coffee, transport, subscriptions, shopping, income, " +
    "transfer, housing, other) and a positive dollar amount.",
  z.object({
    slices: z
      .array(
        z.object({
          category: z.enum([
            "dining", "groceries", "coffee", "transport", "subscriptions",
            "shopping", "income", "transfer", "housing", "other",
          ]),
          amount: z.number().positive(),
        }),
      )
      .min(1)
      .max(12),
    /** Diameter in px (default 200). */
    size: z.number().min(120).max(360).optional(),
  }),
);

export const mapleHostDescriptors = [sparklineDescriptor, spendingDonutDescriptor];

/** F1 registry entries (source:"host") for the provider + genui validation. */
export const mapleHostComponents = toHostRegistry(mapleHostDescriptors);
