import { z } from "zod";
import { prewired } from "../../descriptor";

export const imageSchema = z.object({
  src: z.string(),
  alt: z.string().optional(),
  caption: z.string().optional(),
});

export const imageDescriptor = prewired(
  "Image",
  "A single image with optional alt text and caption. Use to show a picture, screenshot, or diagram.",
  imageSchema,
);
