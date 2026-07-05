import { ImageGallery as UIImageGallery } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { allowlistUrl } from "../../impl-helpers/safe-url";
import { imageGallerySchema } from "./descriptor";

export const ImageGallery = createPrewiredImpl(imageGallerySchema, (p) => {
  const safeImages = p.images
    .map((img) => ({ src: allowlistUrl(img.src), alt: img.alt ?? "" }))
    .filter((img): img is { src: string; alt: string } => img.src !== undefined);

  if (safeImages.length === 0) {
    return <div data-testid="vendo-gallery-empty" />;
  }

  return <UIImageGallery images={safeImages} />;
});
