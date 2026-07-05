import type { BrandTokens } from "./brand";

/**
 * The single canonical `--vendo-*` producer. Both the host shell and the
 * sandbox stage call this function so they always render from the exact
 * same values — the derived formulas (border/shadow/skeleton) live here
 * once, so host and sandbox can never drift apart.
 */
export function brandToCssVars(brand: BrandTokens): Record<string, string> {
  const radius = typeof brand.radius === "number" ? `${brand.radius}px` : brand.radius;

  return {
    "--vendo-accent": brand.accent,
    "--vendo-bg": brand.background,
    "--vendo-surface": brand.surface,
    "--vendo-fg": brand.text,
    "--vendo-fg-muted": brand.mutedText,
    "--vendo-font": brand.fontFamily,
    "--vendo-radius": radius,
    "--vendo-border": `color-mix(in srgb, ${brand.text} 12%, ${brand.surface})`,
    "--vendo-skeleton": `color-mix(in srgb, ${brand.text} 8%, ${brand.surface})`,
    "--vendo-shadow": `0 1px 2px color-mix(in srgb, ${brand.text} 8%, transparent)`,
  };
}
