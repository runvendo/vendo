import { z } from "zod";
import { prewired } from "../../descriptor.js";

export const listSchema = z.object({
  items: z.array(z.object({ title: z.string(), subtitle: z.string().optional() })).min(1),
});

export const listDescriptor = prewired(
  "List",
  "A vertical list of items, each with a title and optional subtitle. Use for menus, search results, or simple records.",
  listSchema,
);
