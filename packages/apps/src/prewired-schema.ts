/** Prop contracts for the prewired primitives, surfaced to the model at
 *  generation time and enforced at validation.
 *
 *  The model receives full prop schemas for HOST catalog components but only
 *  the NAMES of the prewired primitives, so it guesses their props from React
 *  convention and guesses wrong (`data` for Table's `rows`, `onPress` for
 *  Button's `onClick`, `labelKey` on Select). This module is the fix: a compact
 *  signature per primitive for the prompt, plus the exact allowed prop-name set
 *  the validator rejects unknown names against (routed to repair).
 *
 *  SOURCE OF TRUTH: the component implementations in
 *  `@vendoai/ui` `packages/ui/src/tree/{primitives,branded}.tsx`. The drift test
 *  (`prewired-schema.test.ts`) asserts this covers exactly
 *  PREWIRED_COMPONENT_NAMES so a new/renamed primitive can't silently diverge. */
import { KIT_WIRE_COMPONENT_NAMES, kitSpec } from "@vendoai/core";

export interface PrewiredSchema {
  /** Compact, model-facing signature listing the exact prop names + shapes. */
  readonly signature: string;
  /** Every prop name the component reads; validation rejects anything else. */
  readonly props: readonly string[];
}

export const PREWIRED_SCHEMAS: Readonly<Record<string, PrewiredSchema>> = {
  // Layout primitives.
  Stack: { signature: `Stack(gap?: number) — vertical stack; children are nodes`, props: ["gap"] },
  Row: { signature: `Row(gap?: number) — horizontal row; children are nodes`, props: ["gap"] },
  Grid: { signature: `Grid(columns?: number = 2) — equal-width columns; children are nodes`, props: ["columns"] },
  Text: { signature: `Text(text?: string, variant?: "body"|"heading"|"caption") — text goes in the node body or the text prop`, props: ["text", "variant"] },
  Skeleton: { signature: `Skeleton(width?: string|number, height?: string|number)`, props: ["width", "height"] },
  Surface: { signature: `Surface() — padded branded panel; children are nodes`, props: [] },
  Divider: { signature: `Divider() — horizontal rule; no props`, props: [] },

  // Branded primitives (the bug-prone set — exact names matter).
  Card: { signature: `Card(title?: string, description?: string, tone?: "default"|"accent"|"danger") — children are nodes`, props: ["title", "description", "tone"] },
  Button: { signature: `Button(label: string, variant?: "primary"|"secondary"|"danger", disabled?: boolean, onClick?: <tool-or-fn>) — action prop is onClick, NOT onPress`, props: ["label", "variant", "disabled", "onClick"] },
  Input: { signature: `Input(label?, name?, type?, value?, placeholder?, autoComplete?, disabled?, required?, error?, hint?, onChange?: <tool-or-fn>)`, props: ["label", "name", "type", "value", "placeholder", "autoComplete", "disabled", "required", "error", "hint", "onChange"] },
  Select: { signature: `Select(options: (string | {value, label?, disabled?})[], value?, label?, placeholder?, name?, hint?, disabled?, required?, onChange?: <tool-or-fn>) — the list prop is options with {value,label} items, NOT labelKey/valueKey`, props: ["options", "value", "label", "placeholder", "name", "hint", "disabled", "required", "onChange"] },
  Table: { signature: `Table(columns: (string | {key, label?, align?})[], rows: object[], caption?, emptyLabel?, rowKey? = "id") — the data prop is rows (bind it to a Query), NOT data`, props: ["columns", "rows", "caption", "emptyLabel", "rowKey"] },
  Badge: { signature: `Badge(label: string, tone?: "neutral"|"accent"|"danger")`, props: ["label", "tone"] },
  Stat: { signature: `Stat(label: string, value?, trend?, prefix?, suffix?, tone?: "default"|"accent"|"danger")`, props: ["label", "value", "trend", "prefix", "suffix", "tone"] },
  Tabs: { signature: `Tabs(tabs: (string | {value, label, disabled?})[], value?, label?, onChange?: <tool-or-fn>) — items is an accepted alias for tabs`, props: ["tabs", "items", "value", "label", "onChange"] },
};

/** Allowed prop-name set per prewired component, for validation. W3: the
 *  adopted Kit names carry their spec's exact prop-name sets — one map for
 *  every wire-built-in component. */
export const prewiredPropNames: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ...Object.entries(PREWIRED_SCHEMAS).map(([name, schema]) =>
    [name, new Set(schema.props)] as const),
  ...KIT_WIRE_COMPONENT_NAMES.map((name) =>
    [name, new Set(Object.keys(kitSpec(name)?.props ?? {}))] as const),
]);

/** The model-facing block for the LEGACY prewired primitives (the Kit section
 *  is `kitPrompt()`; these lines are generated from PREWIRED_SCHEMAS — no
 *  hand-written prompt list). */
export const prewiredSchemaPrompt = (): string =>
  Object.entries(PREWIRED_SCHEMAS)
    .map(([, schema]) => `- ${schema.signature}`)
    .join("\n");
