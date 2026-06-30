import { z } from "zod";
import { prewired } from "../../descriptor";

export const tagsSchema = z.object({
  items: z
    .array(
      z.object({
        text: z.string(),
        variant: z.enum(["neutral", "info", "success", "warning", "danger"]).optional(),
      }),
    )
    .min(1),
});

export const tagsDescriptor = prewired(
  "Tags",
  "A row of small labels/badges. Use to show categories, statuses, or keywords.",
  tagsSchema,
);
