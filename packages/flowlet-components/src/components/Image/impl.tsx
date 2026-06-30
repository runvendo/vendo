import { Image as UIImage } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { allowlistUrl } from "../../impl-helpers/safe-url";
import { imageSchema } from "./descriptor";

export const Image = createPrewiredImpl(imageSchema, (p) => {
  const safeSrc = allowlistUrl(p.src);
  if (!safeSrc) {
    return <div data-testid="flowlet-blocked-image" />;
  }
  return (
    <figure>
      <UIImage src={safeSrc} alt={p.alt ?? ""} />
      {p.caption ? <figcaption>{p.caption}</figcaption> : null}
    </figure>
  );
});
