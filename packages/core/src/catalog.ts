import { z } from "zod";
import type { JsonSchema } from "./ids.js";

/** 01-core §14 */
export interface StandardSchema {
  "~standard": { validate(value: unknown): unknown };
}

/** 01-core §14 */
export interface RegisteredComponent {
  name: string;
  description: string;
  propsSchema: StandardSchema;
  propsJsonSchema?: JsonSchema;
  examples?: string[];
  remixable?: boolean;
}

/** 01-core §14 */
export type ComponentCatalog = ReadonlyArray<RegisteredComponent>;

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
