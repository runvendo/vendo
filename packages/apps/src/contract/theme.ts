/**
 * The ONE theme → CSS-variable mapping (01 §14, 08 §2/§4). It lives here, in
 * the block every other block may depend on, because three surfaces render the
 * same theme through three different transports: the ui chrome (a React style
 * object), the MCP door's HTML pages (a `style` attribute), and the MCP Apps
 * shim (a `:root{}` declaration block). They used to carry three hand-kept
 * copies of the mapping — mcp's said so in a comment — and they had already
 * drifted: the door emitted 16 of the 32 variables the chrome does. Each
 * consumer now serializes `themeCssVariables()`; nobody restates a name.
 */
import type { VendoTheme } from "./catalog.js";

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
    // Onest is the brand font; the chrome sheet inlines its @font-face
    // (latin + latin-ext subsets, OFL) so the default look renders it without
    // host setup. Hosts with a strict CSP (font-src without data:) block the
    // inlined face and fall back gracefully to the system stack below.
    fontFamily: "Onest, system-ui, -apple-system, 'Segoe UI', sans-serif",
    baseSize: "15px",
  },
  radius: { small: "6px", medium: "10px", large: "16px" },
  density: "comfortable",
  motion: "full",
};

/**
 * The value the mapping fills in for each field the contract marks OPTIONAL, so
 * one fixed set of variable names is emitted whatever vintage a host's theme
 * file is — the door, the shim and the chrome compare that set against each
 * other, and the shim's reverse read throws on a name outside it.
 *
 * Deliberately NOT folded into `defaultVendoTheme`: that object is the shape the
 * MCP Apps shim reconstructs a theme back INTO, and a field the reader cannot
 * recover would make a theme round-trip into a different theme. The Kit reads
 * its own unthemed fallbacks off here, so there is still one copy of each value.
 */
export const themeDefaults = {
  colors: {
    success: "#1e7f53",
    warning: "#d4a017",
    // The host's OWN accent hue rather than a literal blue (`infoColorFor`), so
    // the status that is neither good news nor bad is brand-native too.
    info: infoColorFor("var(--vendo-color-accent)"),
    // One step off the host's OWN surface rather than a literal, so a raised
    // card sits the same distance from the page in any brand and either scheme.
    surfaceRaised: "color-mix(in srgb, var(--vendo-color-surface) 92%, var(--vendo-color-text))",
  },
  typography: {
    // System mono stack — no brand mono font ships.
    monoFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
    weightNormal: "400",
    weightEmphasis: "600",
    letterSpacing: "-0.011em",
    lineHeightBody: "1.5",
    lineHeightHeading: "1.3",
  },
  // The chrome sheet's three elevations, lifted verbatim — its `--vendo-fg` is
  // `var(--vendo-color-text, #14151a)`: the hover lift, the float every element
  // resting above a surface paints, and the overlay panel.
  shadow: {
    small: "0 2px 10px color-mix(in srgb, var(--vendo-color-text, #14151a) 8%, transparent)",
    medium: "0 1px 2px color-mix(in srgb, var(--vendo-color-text, #14151a) 5%, transparent), "
      + "0 10px 28px color-mix(in srgb, var(--vendo-color-text, #14151a) 8%, transparent)",
    large: "0 30px 80px color-mix(in srgb, var(--vendo-color-text, #14151a) 24%, transparent)",
  },
  borderWidth: "1px",
  motionDuration: "160ms",
  motionEasing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
};

/**
 * Series lightness ladder, as `[lightness, chroma scale]` in OKLCH. Absolute
 * lightness rather than `calc(l ± n)` because relative steps collapse for a
 * near-black or near-white accent (the default accent is #111111), and chroma
 * eases off as lightness rises so the pale steps stay in sRGB gamut. Ordered so
 * neighbouring series sit far apart on the ladder.
 */
const chartRamp: ReadonlyArray<readonly [number, number]> = [
  [0.7, 0.9],
  [0.46, 1],
  [0.86, 0.5],
  [0.54, 1],
  [0.78, 0.65],
  [0.38, 1],
  [0.62, 0.95],
];

/**
 * The categorical chart palette an accent implies: the accent itself, then
 * shades and tints that keep its hue (`h`) exactly — so a chart is brand-native
 * on any host and never invents a color. `chartPalette` replaces the first six
 * entry by entry (`--vendo-chart-1..6`); the Kit derives its own fallbacks from
 * this same function, so the two sides cannot drift.
 */
export function chartPaletteFor(accent: string): string[] {
  return [accent, ...chartRamp.map(([l, c]) => `oklch(from ${accent} ${l} calc(c * ${c}) h)`)];
}

/**
 * The "in progress" color an accent implies — the same idiom as
 * {@link chartPaletteFor}: the accent's hue (`h`) exactly, at a mid lightness and
 * eased-off chroma, so a state that is neither good news nor bad is brand-native
 * on any host and never invents a color. NOT the accent itself: a status painted
 * in the brand's own colour reads as the primary action, which is the whole
 * reason a fourth status colour exists. The Kit derives its own fallback from
 * this same function, so the two sides cannot drift.
 */
export function infoColorFor(accent: string): string {
  return `oklch(from ${accent} 0.55 calc(c * 0.75) h)`;
}

/** Deep-merge a partial theme over a base (one level per contract group). */
export function resolveTheme(base: VendoTheme, override?: Partial<VendoTheme>): VendoTheme {
  if (!override) return base;
  return {
    colors: { ...base.colors, ...override.colors },
    typography: { ...base.typography, ...override.typography },
    radius: { ...base.radius, ...override.radius },
    shadow: override.shadow ?? base.shadow,
    density: override.density ?? base.density,
    motion: override.motion ?? base.motion,
    borderWidth: override.borderWidth ?? base.borderWidth,
    chartPalette: override.chartPalette ?? base.chartPalette,
    motionDuration: override.motionDuration ?? base.motionDuration,
    motionEasing: override.motionEasing ?? base.motionEasing,
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

/**
 * The spacing scale one density implies, on its own.
 *
 * Split out of `themeCssVariables` because density is no longer only a
 * page-level setting: a Kit container takes a `density` adjective and re-emits
 * this same scale on its own element, so the compact table inside a comfortable
 * page is the SAME compact the host would have got. One ladder, two callers —
 * a second copy in the Kit would be a scale that drifts.
 */
export function densityCssVariables(density: VendoTheme["density"]): Record<string, string> {
  const compact = density === "compact";
  return {
    // Normalized, not passed through: `density` widens to `string` so a JSON
    // import assigns uncast, and every step below already reads an unknown
    // value as comfortable — the adjective must say the same thing.
    "--vendo-density": compact ? "compact" : "comfortable",
    "--vendo-density-control-height": compact ? "32px" : "38px",
    "--vendo-density-control-padding": compact ? "6px 10px" : "9px 12px",
    "--vendo-density-card-padding": compact ? "12px" : "16px",
    "--vendo-density-content-gap": compact ? "7px" : "10px",
    "--vendo-density-inline-gap": compact ? "5px" : "7px",
    "--vendo-density-field-gap": compact ? "4px" : "6px",
    "--vendo-density-table-padding": compact ? "7px 10px" : "10px 12px",
    "--vendo-density-badge-height": compact ? "20px" : "24px",
    "--vendo-density-badge-padding": compact ? "3px 7px" : "5px 9px",
    "--vendo-density-stat-padding": compact ? "9px 11px" : "12px 14px",
    "--vendo-density-tabs-padding": compact ? "3px" : "4px",
    "--vendo-density-tab-height": compact ? "26px" : "30px",
    "--vendo-density-tab-padding": compact ? "4px 8px" : "6px 10px",
  };
}

/** Flatten a theme into `--vendo-*` CSS custom properties. Each optional field
 * resolves against `themeDefaults`, so the NAMES emitted are one fixed set whatever
 * vintage the host's theme file is — the door, the shim and the chrome compare
 * that set, and the shim's reverse read rejects a name outside it. */
export function themeCssVariables(theme: VendoTheme): Record<string, string> {
  const vars: Record<string, string> = {};
  const type = { ...themeDefaults.typography, ...theme.typography };
  for (const [key, value] of Object.entries({ ...themeDefaults.colors, ...theme.colors })) {
    vars[`--vendo-color-${kebab(key)}`] = value;
  }
  vars["--vendo-color-scheme"] = colorSchemeForBackground(theme.colors.background);
  vars["--vendo-font-family"] = type.fontFamily;
  if (type.headingFamily) vars["--vendo-heading-family"] = type.headingFamily;
  vars["--vendo-mono-family"] = type.monoFamily;
  vars["--vendo-font-size"] = type.baseSize;
  // baseSize is the anchor of the chrome type scale: the sheet derives every
  // text size (and a couple of spacing steps) from --vendo-base-size via calc,
  // so a host's baseSize scales the whole surface instead of only the root font.
  vars["--vendo-base-size"] = type.baseSize;
  vars["--vendo-font-weight-normal"] = type.weightNormal;
  vars["--vendo-font-weight-emphasis"] = type.weightEmphasis;
  vars["--vendo-letter-spacing"] = type.letterSpacing;
  vars["--vendo-line-height"] = type.lineHeightBody;
  vars["--vendo-line-height-heading"] = type.lineHeightHeading;
  for (const [key, value] of Object.entries(theme.radius)) vars[`--vendo-radius-${kebab(key)}`] = value;
  for (const [key, value] of Object.entries(theme.shadow ?? themeDefaults.shadow)) {
    vars[`--vendo-shadow-${kebab(key)}`] = value;
  }
  vars["--vendo-border-width"] = theme.borderWidth ?? themeDefaults.borderWidth;
  for (const [i, color] of chartPaletteFor(theme.colors.accent).slice(0, 6).entries()) {
    vars[`--vendo-chart-${i + 1}`] = theme.chartPalette?.[i] ?? color;
  }
  Object.assign(vars, densityCssVariables(theme.density));
  vars["--vendo-motion"] = theme.motion === "reduced" ? "reduced" : "full";
  vars["--vendo-motion-duration"] = theme.motion === "reduced"
    ? "0ms"
    : theme.motionDuration ?? themeDefaults.motionDuration;
  vars["--vendo-motion-easing"] = theme.motionEasing ?? themeDefaults.motionEasing;
  return vars;
}

/**
 * Every variable name the mapping can emit — READ OFF the mapping (a probe
 * theme that sets headingFamily, the one field emitted only when a host declares
 * it; the rest resolve against the defaults), never hand-listed, so a consumer
 * that teaches or reads these names cannot fall behind a rename. Two do:
 * the generation prompt's brand-token line and the MCP Apps shim's reverse
 * read.
 */
export const VENDO_THEME_VARIABLE_NAMES: readonly string[] = Object.keys(themeCssVariables({
  ...defaultVendoTheme,
  typography: { ...defaultVendoTheme.typography, headingFamily: "probe" },
}));

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}
