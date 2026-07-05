import { ListBlock, ListItem } from "../../openui.js";
import { createPrewiredImpl } from "../../impl-helpers/create-impl.js";
import { listSchema } from "./descriptor.js";

export const List = createPrewiredImpl(listSchema, (p) => (
  <ListBlock>
    {p.items.map((item, i) => (
      <ListItem
        key={i}
        title={<span>{item.title}</span>}
        subtitle={item.subtitle ? <span>{item.subtitle}</span> : undefined}
      />
    ))}
  </ListBlock>
));
