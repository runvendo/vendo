import { Tag, TagBlock } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { tagsSchema } from "./descriptor";

export const Tags = createPrewiredImpl(tagsSchema, (p) => (
  <TagBlock>
    {p.items.map((t, i) => (
      <Tag key={i} text={<span>{t.text}</span>} />
    ))}
  </TagBlock>
));
