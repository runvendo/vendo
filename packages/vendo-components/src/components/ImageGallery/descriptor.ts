import { z } from "zod";
import { prewired } from "../../descriptor";

export const imageGallerySchema = z.object({
  images: z
    .array(
      z.object({
        src: z
          .string()
          .describe("Image source. Only data:image URIs are supported; remote/https URLs will not load."),
        alt: z.string().optional(),
      }),
    )
    .min(1)
    .max(60),
});

export const imageGalleryDescriptor = prewired(
  "ImageGallery",
  "A grid/gallery of images. Use to present multiple related pictures.",
  imageGallerySchema,
);
