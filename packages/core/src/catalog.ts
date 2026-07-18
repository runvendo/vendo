import { z } from "zod";
import type { JsonSchema } from "./ids.js";

/** 01-core §14 */
export interface StandardSchema {
  "~standard": { validate(value: unknown): unknown };
}

/** 01-core §14 (amended 2026-07-18): one optional props schema per entry;
 * the model-facing JSON Schema is derived internally by the composition —
 * hosts never hand-write it (`propsJsonSchema` is removed). Schema-less
 * entries are legal: the model infers props and validation is permissive. */
export interface RegisteredComponent {
  name: string;
  description: string;
  propsSchema?: StandardSchema;
  examples?: string[];
  remixable?: boolean;
}

/** 01-core §14 */
export type ComponentCatalog = ReadonlyArray<RegisteredComponent>;

/** 01-core §14 (2026-07-18 amendment) — name-keyed registry form. The same
 * object serves both sides: the server reads the data fields, <VendoRoot>
 * reads the component references. The composition normalizes registry →
 * catalog entry by entry: key → `name`, `props` → `propsSchema`, `component`
 * dropped (the server MUST IGNORE it — never touched, never executed). */
export interface ComponentRegistryEntry {
  /** Host component reference for the client side; ignored server-side. */
  component: unknown;
  description: string;
  /** The ONE optional props schema — same StandardSchema, same derivation. */
  props?: StandardSchema;
  examples?: string[];
  remixable?: boolean;
}

/** 01-core §14 — keys are component names (PascalCase). */
export type ComponentRegistry = Record<string, ComponentRegistryEntry>;

/** The composition's internal normalized catalog entry (01 §14 amendment):
 * `propsJsonSchema` here is DERIVED — from the entry's single zod schema at
 * normalization time, or loaded verbatim from catalog@1's disk `propsSchema`
 * field — never hand-written by hosts. It drives both the generation prompt
 * and generated-props validation (04 §1). */
export interface NormalizedCatalogEntry extends RegisteredComponent {
  propsJsonSchema?: JsonSchema;
}

/** The normalized internal catalog the composition hands to the apps block. */
export type NormalizedCatalog = ReadonlyArray<NormalizedCatalogEntry>;

/** 01-core §14 */
export interface VendoTheme {
  colors: {
    background: string;
    surface: string;
    text: string;
    muted: string;
    accent: string;
    accentText: string;
    danger: string;
    border: string;
  };
  typography: { fontFamily: string; headingFamily?: string; baseSize: string };
  radius: { small: string; medium: string; large: string };
  density: "compact" | "comfortable";
  motion: "full" | "reduced";
}

/** 01-core §14 */
export const vendoThemeSchema = z.object({
  colors: z.object({
    background: z.string(),
    surface: z.string(),
    text: z.string(),
    muted: z.string(),
    accent: z.string(),
    accentText: z.string(),
    danger: z.string(),
    border: z.string(),
  }).passthrough(),
  typography: z.object({
    fontFamily: z.string(),
    headingFamily: z.string().optional(),
    baseSize: z.string(),
  }).passthrough(),
  radius: z.object({
    small: z.string(),
    medium: z.string(),
    large: z.string(),
  }).passthrough(),
  density: z.enum(["compact", "comfortable"]),
  motion: z.enum(["full", "reduced"]),
}).passthrough() satisfies z.ZodType<VendoTheme>;
