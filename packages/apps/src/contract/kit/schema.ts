/**
 * Kit prop schemas + classing (W2 §The Kit).
 *
 * Every prop is a `PropSpec`: a zod schema, a class, and a one-line doc. The
 * class is the enforcement handle for the two laws —
 *   - `data`   props must trace to a tool call (law 1);
 *   - `config` props tune behavior (sort, limit, format);
 *   - `copy`   props are human-facing strings the model may write freely.
 * The same specs are the single source for the GENERATED prompt (`kitPrompt`)
 * and for runtime validation (`propsSchema`). Hand-written prop lists are dead.
 */
import { z, type ZodTypeAny } from "zod";

export type PropClass = "config" | "copy" | "data";

export interface PropSpec {
  cls: PropClass;
  schema: ZodTypeAny;
  doc: string;
  required?: boolean;
}

interface PropOptions {
  required?: boolean;
}

function make(cls: PropClass, schema: ZodTypeAny, doc: string, options: PropOptions = {}): PropSpec {
  return { cls, schema, doc, required: options.required ?? false };
}

/** A behavior/tuning prop (sort, limit, format, tone). */
export function config(schema: ZodTypeAny, doc: string, options?: PropOptions): PropSpec {
  return make("config", schema, doc, options);
}

/** A human-facing string the model may author (label, title, empty-state text). */
export function copy(schema: ZodTypeAny, doc: string, options?: PropOptions): PropSpec {
  return make("copy", schema, doc, options);
}

/** A prop that must trace to a tool call — real business data (law 1). */
export function data(schema: ZodTypeAny, doc: string, options?: PropOptions): PropSpec {
  return make("data", schema, doc, options);
}

/**
 * A SLOT — a named place inside a component that holds an ELEMENT instead of a
 * value (a table column's `cell`, a Timeline's `marker`). It is a prop of its
 * own, or a field of the description objects one prop holds; `at` says which,
 * and `kitSlotPath` writes the two as one comparable string.
 */
export interface KitSlotSpec {
  /** 1-line "what goes here". */
  doc: string;
  /** Component names the slot may hold; absent means the read-only value tier
   *  (`KIT_SLOT_CONTENT_NAMES`). */
  content?: readonly string[];
  /** Painted once per row/entry rather than once for the component — so what
   *  is written in it has no row of its own to act on. */
  perRow?: boolean;
  /** The PROP whose description objects carry this slot as a field, so the slot
   *  lives at `<at>[].<name>` (`columns[].cell`). Absent means the slot is a
   *  prop of its own (`marker`).
   *
   *  Load-bearing, not documentation: a component reads its slot at exactly one
   *  place, so a same-named field anywhere else (`rows[].cell` on a DataTable
   *  that only renders `columns[].cell`) is a value nothing paints. The nesting
   *  check matches on this path and refuses the rest. */
  at?: string;
}

export interface KitComponentSpec {
  /** JSX tag name the model emits. */
  name: string;
  /** 1-2 sentence "when to use". */
  summary: string;
  /** Prop name → spec. */
  props: Record<string, PropSpec>;
  /** 1-2 canonical JSX examples. */
  examples: string[];
  /** Optional group for prompt organization (layout, values, data, charts, forms). */
  group?: string;
  /** Does this component RENDER what is nested inside it? Absent means no — most
   *  of the Kit is a leaf, and the renderer hands children to leaves too. */
  takesChildren?: boolean;
  /** Slot name → spec. Absent means the component takes no elements in its
   *  props at all, and one written there is refused rather than dropped. */
  slots?: Record<string, KitSlotSpec>;
  /**
   * The third-party engine this component RENDERS ("recharts", "Base UI"), whose
   * own props pass through to it. Absent means the component wraps nothing, and
   * its prop list is closed — an undeclared name there is the "valid component,
   * nothing happens" class the floor refuses.
   *
   * An engine's prop vocabulary is the engine's, not ours: it is admitted
   * unvalidated, so an engine upgrade is free and a stored app naming a prop the
   * engine has since renamed or dropped renders wrong until it is regenerated.
   */
  engine?: string;
}

/** Build a `z.object` from a spec's props, applying `.optional()` to non-required
 *  ones. An engine-backed spec stays OPEN, because the engine's own props are
 *  legal on it and a stripped `stroke` is a series that silently keeps the theme. */
export function propsSchema(spec: KitComponentSpec): z.ZodObject<z.ZodRawShape, z.UnknownKeysParam> {
  const shape: z.ZodRawShape = {};
  for (const [name, prop] of Object.entries(spec.props)) {
    shape[name] = prop.required ? prop.schema : prop.schema.optional();
  }
  const object = z.object(shape);
  return spec.engine === undefined ? object : object.passthrough();
}

/** Validate a props object against a spec. Returns zod's SafeParse result. */
export function validateProps(spec: KitComponentSpec, props: unknown) {
  return propsSchema(spec).safeParse(props);
}
