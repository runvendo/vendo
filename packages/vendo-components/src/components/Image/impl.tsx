import { Image as UIImage } from "../../openui.js";
import { createPrewiredImpl } from "../../impl-helpers/create-impl.js";
import { allowlistUrl } from "../../impl-helpers/safe-url.js";
import { imageSchema } from "./descriptor.js";

export const Image = createPrewiredImpl(imageSchema, (p) => {
  const safeSrc = allowlistUrl(p.src);
  if (!safeSrc) {
    return <div data-testid="vendo-blocked-image" />;
  }
  return (
    <figure>
      <UIImage src={safeSrc} alt={p.alt ?? ""} />
      {p.caption ? <figcaption>{p.caption}</figcaption> : null}
    </figure>
  );
});
