import {
  Card as _Card,
  CardHeader as _CardHeader,
  Tag as _Tag,
  TagBlock as _TagBlock,
} from "@openuidev/react-ui";
import type {
  CardProps,
  CardHeaderProps,
  TagProps,
  TagBlockProps,
} from "@openuidev/react-ui";
import type { ComponentType, ReactNode } from "react";

/**
 * OpenUI ships @types/react@19 types (ReactNode includes bigint); this monorepo
 * pins @types/react@18, so every OpenUI component trips TS2786 at JSX call sites.
 * Cast them ONCE here to React-18 ComponentTypes with prop types preserved.
 * All wrappers import OpenUI components from this module, never from the package directly.
 */
const ui = <P,>(component: unknown): ComponentType<P> =>
  component as unknown as ComponentType<P>;

export const Card = ui<CardProps & { children?: ReactNode }>(_Card);
export const CardHeader = ui<CardHeaderProps>(_CardHeader);
export const Tag = ui<TagProps>(_Tag);
export const TagBlock = ui<TagBlockProps & { children?: ReactNode }>(_TagBlock);
