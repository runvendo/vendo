import { z } from "zod";
import { prewired } from "../../descriptor";

export const accordionSchema = z.object({
  items: z.array(z.object({ title: z.string(), content: z.string() })).min(1),
});

export const accordionDescriptor = prewired(
  "Accordion",
  "A vertical list of collapsible title/content sections. Use for FAQs or grouped details the user can expand.",
  accordionSchema,
);
