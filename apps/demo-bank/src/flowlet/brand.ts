import type { BrandTokens } from "@flowlet/components";

/**
 * Maple's single brand source of truth. This one object feeds BOTH surfaces —
 * the host shell (via FlowletRoot's brand vars + FlowletThemeProvider) and the
 * generated-UI sandbox (via SandboxStage's brandToCssVars + mapBrandToTheme).
 *
 * Values are derived from the demo's original `mapleTheme` (FlowletTheme) so the
 * look is unchanged: accent=fg graphite, warm-paper bg, white surface. Only the
 * primitives BrandTokens models are carried here; border/shadow/skeleton are
 * derived downstream by brandToCssVars.
 */
export const mapleBrand: BrandTokens = {
  version: 1,
  accent: "#1B1C22", // mapleTheme.accent (graphite)
  background: "#F4F3F0", // mapleTheme.bg (warm paper)
  surface: "#FFFFFF", // mapleTheme.surface
  text: "#14151A", // mapleTheme.fg
  mutedText: "#8A8B92", // mapleTheme.fgMuted
  fontFamily: "var(--font-inter), ui-sans-serif, system-ui, sans-serif", // mapleTheme.font
  radius: "16px", // mapleTheme.radius
  mode: "light",
};
