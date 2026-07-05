import { z } from "zod";
import { prewired } from "../../descriptor.js";

export const emptyStateSchema = z.object({
  variant: z.enum(["empty", "error"]),
  title: z.string().min(1),
  message: z.string().optional(),
});

export const emptyStateDescriptor = prewired(
  "EmptyState",
  "A contained empty/error state block: quiet icon, title, optional message. Use " +
    "'empty' when a query legitimately returns nothing ('No transactions this " +
    "month') and 'error' when data could not be loaded. Never fabricate data to " +
    "avoid an empty view — render this instead.",
  emptyStateSchema,
);
