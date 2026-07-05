import { z } from "zod";
import { prewired } from "../../descriptor.js";

export const carouselSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().optional(),
        body: z.string().optional(),
        imageUrl: z
          .string()
          .optional()
          .describe("Image source. Only data:image URIs are supported; remote/https URLs will not load."),
      }),
    )
    .min(1),
});

export const carouselDescriptor = prewired(
  "Carousel",
  "A horizontally scrollable set of slides, each with an optional title, body, and image. Use to present multiple options or cards side by side.",
  carouselSchema,
);
