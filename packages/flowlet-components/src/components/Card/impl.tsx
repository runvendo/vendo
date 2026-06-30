import {
  Card as _Card,
  CardHeader as _CardHeader,
  Tag as _Tag,
  TagBlock as _TagBlock,
} from "@openuidev/react-ui";
import type { CardProps, CardHeaderProps, TagProps, TagBlockProps } from "@openuidev/react-ui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { resolveIcon } from "../../impl-helpers/icon";
import { cardSchema } from "./descriptor";

// OpenUI ships @types/react@19 types; ForwardRefExoticComponent's ReactNode
// return type is incompatible with this package's @types/react@18 context.
// Re-cast each component to a plain ComponentType so TypeScript is satisfied
// while keeping full prop types intact at the call sites.
const UICard = _Card as unknown as React.ComponentType<
  CardProps & { children?: React.ReactNode }
>;
const UICardHeader = _CardHeader as unknown as React.ComponentType<CardHeaderProps>;
const UITag = _Tag as unknown as React.ComponentType<TagProps>;
const UITagBlock = _TagBlock as unknown as React.ComponentType<TagBlockProps>;

export const Card = createPrewiredImpl(cardSchema, (p) => (
  <UICard variant="card" width="standard">
    <UICardHeader
      title={<span>{p.title}</span>}
      subtitle={p.subtitle ? <span>{p.subtitle}</span> : undefined}
      icon={resolveIcon(p.iconName)}
    />
    {p.body ? <p>{p.body}</p> : null}
    {p.tags && p.tags.length > 0 ? (
      <UITagBlock>
        {p.tags.map((t) => (
          <UITag key={t} text={<span>{t}</span>} />
        ))}
      </UITagBlock>
    ) : null}
  </UICard>
));
