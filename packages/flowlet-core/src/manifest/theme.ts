import { z } from "zod";

/** A literal hex color (#rgb / #rgba / #rrggbb / #rrggbbaa). No var()/url() references. */
const hexColor = z
  .string()
  .regex(/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);

/**
 * `theme.json` — extracted host design tokens (dev-tool artifact 1 of 3,
 * architecture Decision 3). Fully resolved primitives only: the sandbox has no
 * host CSS vars or loaded fonts.
 *
 * Structurally identical to `BrandTokens` v1 in `@flowlet/components`
 * (`src/theme/brand.ts`), which is the consuming side of this contract; a
 * reconciliation test there keeps the two in sync until they are folded together.
 */
export const manifestThemeSchema = z
  .object({
    version: z.literal(1),
    accent: hexColor,
    background: hexColor,
    surface: hexColor,
    text: hexColor,
    mutedText: hexColor,
    fontFamily: z.string().min(1),
    radius: z.union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d+)?px$/)]),
    mode: z.enum(["light", "dark"]).optional(),
  })
  .strict();

export type ManifestTheme = z.infer<typeof manifestThemeSchema>;
