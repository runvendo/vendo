import { z } from "zod";
import { prewired } from "../../descriptor";

export const imageGallerySchema = z.object({
  images: z.array(z.object({ src: z.string(), alt: z.string().optional() })).min(1),
});

export const imageGalleryDescriptor = prewired(
  "ImageGallery",
  "A grid/gallery of images. Use to present multiple related pictures.",
  imageGallerySchema,
);
