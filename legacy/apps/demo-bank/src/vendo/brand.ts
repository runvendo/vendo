import type { BrandTokens } from "@vendoai/components";

/**
 * Maple's single brand source of truth. This one object feeds BOTH surfaces —
 * the host shell (via VendoRoot's brand vars + VendoThemeProvider) and the
 * generated-UI sandbox (via SandboxStage's brandToCssVars + mapBrandToTheme).
 *
 * Values are derived from the demo's original `mapleTheme` (VendoTheme) so the
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
  // Concrete stack — BrandTokens must be fully resolved primitives. A var()
  // here cannot resolve inside the sandbox iframe (host vars don't exist
  // there) and invalidates the whole font-family declaration, falling back to
  // UA serif. Inter isn't loaded in the sandbox (next/font registers it under
  // a mangled name, host-only), so the box lands on ui-sans-serif; the host
  // shell keeps real Inter via the delivery override in VendoRoot.
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  radius: "16px", // mapleTheme.radius
  mode: "light",
};
