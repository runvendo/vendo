import { Tag, TagBlock } from "../../openui.js";
import { createPrewiredImpl } from "../../impl-helpers/create-impl.js";
import { tagsSchema } from "./descriptor.js";

export const Tags = createPrewiredImpl(tagsSchema, (p) => (
  <TagBlock>
    {p.items.map((t, i) => (
      <Tag key={i} text={<span>{t.text}</span>} variant={t.variant} />
    ))}
  </TagBlock>
));
