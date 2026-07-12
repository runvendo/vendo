/**
 * VendoTheme resolution (08 §2, §4). All chrome styles derive from these CSS
 * variables — no hardcoded brand anywhere in the package.
 *
 * The resolved theme = defaults ⊕ VendoProvider.theme. The server-extracted
 * theme (.vendo/theme.json) reaches the provider through the umbrella's
 * <VendoRoot>; ui itself has no theme wire route (09 §3 has none).
 */
import type { VendoTheme } from "@vendoai/core";

/** Deliberately neutral: readable everywhere, branded nowhere. */
export const defaultVendoTheme: VendoTheme = {
  colors: {
    background: "#ffffff",
    surface: "#f7f7f8",
    text: "#1a1a1e",
    muted: "#6b6b76",
    accent: "#2f5af5",
    accentText: "#ffffff",
    danger: "#c62f2f",
    border: "#e3e3e8",
  },
  typography: {
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    baseSize: "15px",
  },
  radius: { small: "6px", medium: "10px", large: "16px" },
  density: "comfortable",
  motion: "full",
};

/** Deep-merge a partial theme over a base (one level per contract group). */
export function resolveTheme(base: VendoTheme, override?: Partial<VendoTheme>): VendoTheme {
  if (!override) return base;
  return {
    colors: { ...base.colors, ...override.colors },
    typography: { ...base.typography, ...override.typography },
    radius: { ...base.radius, ...override.radius },
    density: override.density ?? base.density,
    motion: override.motion ?? base.motion,
  };
}

/** Flatten a theme into `--vendo-*` CSS custom properties. */
export function themeCssVariables(theme: VendoTheme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) vars[`--vendo-color-${kebab(key)}`] = value;
  vars["--vendo-font-family"] = theme.typography.fontFamily;
  if (theme.typography.headingFamily) vars["--vendo-heading-family"] = theme.typography.headingFamily;
  vars["--vendo-font-size"] = theme.typography.baseSize;
  for (const [key, value] of Object.entries(theme.radius)) vars[`--vendo-radius-${kebab(key)}`] = value;
  vars["--vendo-density"] = theme.density;
  vars["--vendo-motion"] = theme.motion;
  return vars;
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}
