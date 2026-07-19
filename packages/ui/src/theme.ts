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
    accent: "#111111",
    accentText: "#ffffff",
    danger: "#c62f2f",
    border: "#e3e3e8",
  },
  typography: {
    // Onest is the brand font; the chrome sheet inlines its @font-face (latin
    // subsets, OFL) so the default look renders it without host setup.
    fontFamily: "Onest, system-ui, -apple-system, 'Segoe UI', sans-serif",
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

/**
 * Which `color-scheme` a background color implies (ENG-226). WCAG relative
 * luminance of `colors.background`, flipped at L = 0.179 — the point where
 * white text contrasts a background better than black text does. No new
 * contract token: the scheme is DERIVED, and it drives the existing
 * `light-dark()` branches in the chrome sheet via `--vendo-color-scheme`.
 * Unparseable colors (non-hex) fall back to light.
 */
export function colorSchemeForBackground(background: string): "light" | "dark" {
  const luminance = relativeLuminance(background);
  return luminance !== null && luminance < 0.179 ? "dark" : "light";
}

/** WCAG 2.x relative luminance of a #rgb/#rgba/#rrggbb/#rrggbbaa color; null if unparseable. */
function relativeLuminance(color: string): number | null {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim())?.[1];
  if (!hex || hex.length === 5 || hex.length === 7) return null;
  const wide = hex.length <= 4 ? [...hex].map((ch) => ch + ch).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const srgb = parseInt(wide.slice(i, i + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Flatten a theme into `--vendo-*` CSS custom properties. */
export function themeCssVariables(theme: VendoTheme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.colors)) vars[`--vendo-color-${kebab(key)}`] = value;
  vars["--vendo-color-scheme"] = colorSchemeForBackground(theme.colors.background);
  vars["--vendo-font-family"] = theme.typography.fontFamily;
  if (theme.typography.headingFamily) vars["--vendo-heading-family"] = theme.typography.headingFamily;
  vars["--vendo-font-size"] = theme.typography.baseSize;
  // baseSize is the anchor of the chrome type scale: the sheet derives every
  // text size (and a couple of spacing steps) from --vendo-base-size via calc,
  // so a host's baseSize scales the whole surface instead of only the root font.
  vars["--vendo-base-size"] = theme.typography.baseSize;
  for (const [key, value] of Object.entries(theme.radius)) vars[`--vendo-radius-${kebab(key)}`] = value;
  vars["--vendo-density"] = theme.density;
  vars["--vendo-motion"] = theme.motion;
  const compact = theme.density === "compact";
  vars["--vendo-density-control-height"] = compact ? "32px" : "38px";
  vars["--vendo-density-control-padding"] = compact ? "6px 10px" : "9px 12px";
  vars["--vendo-density-card-padding"] = compact ? "12px" : "16px";
  vars["--vendo-density-content-gap"] = compact ? "7px" : "10px";
  vars["--vendo-density-inline-gap"] = compact ? "5px" : "7px";
  vars["--vendo-density-field-gap"] = compact ? "4px" : "6px";
  vars["--vendo-density-table-padding"] = compact ? "7px 10px" : "10px 12px";
  vars["--vendo-density-badge-height"] = compact ? "20px" : "24px";
  vars["--vendo-density-badge-padding"] = compact ? "3px 7px" : "5px 9px";
  vars["--vendo-density-stat-padding"] = compact ? "9px 11px" : "12px 14px";
  vars["--vendo-density-tabs-padding"] = compact ? "3px" : "4px";
  vars["--vendo-density-tab-height"] = compact ? "26px" : "30px";
  vars["--vendo-density-tab-padding"] = compact ? "4px 8px" : "6px 10px";
  vars["--vendo-motion-duration"] = theme.motion === "reduced" ? "0ms" : "160ms";
  vars["--vendo-motion-easing"] = "cubic-bezier(0.2, 0.8, 0.2, 1)";
  return vars;
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}
