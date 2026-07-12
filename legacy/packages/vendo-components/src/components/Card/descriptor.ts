import { z } from "zod";
import { prewired } from "../../descriptor.js";

export const cardSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  iconName: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const cardDescriptor = prewired(
  "Card",
  "A titled content card with optional subtitle, icon, body text, and tags. Use to present a single record, summary, or labeled block of information.",
  cardSchema,
);
