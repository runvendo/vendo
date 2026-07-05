import { Card as UICard, CardHeader, Tag, TagBlock } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { resolveIcon } from "../../impl-helpers/icon";
import { cardSchema } from "./descriptor";

export const Card = createPrewiredImpl(cardSchema, (p) => (
  <UICard variant="card" width="standard">
    <CardHeader
      title={<span>{p.title}</span>}
      subtitle={p.subtitle ? <span>{p.subtitle}</span> : undefined}
      icon={resolveIcon(p.iconName)}
    />
    {p.body ? <p>{p.body}</p> : null}
    {p.tags && p.tags.length > 0 ? (
      <TagBlock>
        {p.tags.map((t) => (
          <Tag key={t} text={<span>{t}</span>} />
        ))}
      </TagBlock>
    ) : null}
  </UICard>
));
