import { z } from "zod";

/** A literal hex color (#rgb / #rrggbb / #rrggbbaa). No var()/url() references. */
const hexColor = z.string().regex(/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);

/**
 * Serializable, versioned host-brand tokens. Fully resolved primitives only —
 * literal colors, a literal font-stack string, a numeric radius (px). The F3
 * sandbox has no host CSS vars or loaded fonts.
 */
export const brandTokensSchema = z.object({
  version: z.literal(1),
  accent: hexColor,
  background: hexColor,
  surface: hexColor,
  text: hexColor,
  mutedText: hexColor,
  fontFamily: z.string().min(1),
  radius: z.union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d+)?px$/)]),
  mode: z.enum(["light", "dark"]).optional(),
});

export type BrandTokens = z.infer<typeof brandTokensSchema>;

export const defaultBrand: BrandTokens = {
  version: 1,
  accent: "#0A7CFF",
  background: "#FFFFFF",
  surface: "#F5F7FA",
  text: "#111418",
  mutedText: "#5B6470",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  radius: 8,
  mode: "light",
};
