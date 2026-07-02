import type { BrandTokens } from "./brand";

/**
 * The single canonical `--flowlet-*` producer. Both the host shell and the
 * sandbox stage call this function so they always render from the exact
 * same values — the derived formulas (border/shadow/skeleton) live here
 * once, so host and sandbox can never drift apart.
 */
export function brandToCssVars(brand: BrandTokens): Record<string, string> {
  const radius = typeof brand.radius === "number" ? `${brand.radius}px` : brand.radius;

  return {
    "--flowlet-accent": brand.accent,
    "--flowlet-bg": brand.background,
    "--flowlet-surface": brand.surface,
    "--flowlet-fg": brand.text,
    "--flowlet-fg-muted": brand.mutedText,
    "--flowlet-font": brand.fontFamily,
    "--flowlet-radius": radius,
    "--flowlet-border": `color-mix(in srgb, ${brand.text} 12%, ${brand.surface})`,
    "--flowlet-skeleton": `color-mix(in srgb, ${brand.text} 8%, ${brand.surface})`,
    "--flowlet-shadow": `0 1px 2px color-mix(in srgb, ${brand.text} 8%, transparent)`,
  };
}
