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
}

/** Build a `z.object` from a spec's props, applying `.optional()` to non-required ones. */
export function propsSchema(spec: KitComponentSpec): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  for (const [name, prop] of Object.entries(spec.props)) {
    shape[name] = prop.required ? prop.schema : prop.schema.optional();
  }
  return z.object(shape);
}

/** Validate a props object against a spec. Returns zod's SafeParse result. */
export function validateProps(spec: KitComponentSpec, props: unknown) {
  return propsSchema(spec).safeParse(props);
}
