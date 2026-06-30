import { ListBlock, ListItem } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { listSchema } from "./descriptor";

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
