import type { FluidTheme } from "fluidkit";
import type { FlowletTheme } from "./theme";

/** Structural BrandTokens (as extracted by flowlet init) — typed structurally so
 *  the shell needs no dependency on @flowlet/components. */
export interface BrandLike {
  accent?: string;
  background?: string;
  surface?: string;
  text?: string;
  mutedText?: string;
  fontFamily?: string;
  radius?: string | number;
  mode?: "light" | "dark";
}

/**
 * BrandTokens → FlowletTheme, for host roots that today pass the brand only as
 * opaque cssVars. The shell never inspects cssVars (deliberate), so roots that
 * want brand-derived fluidkit chrome pass `theme={brandToFlowletTheme(brand)}`
 * alongside the cssVars they already send.
 */
export function brandToFlowletTheme(brand: BrandLike): FlowletTheme {
  const out: FlowletTheme = {};
  if (brand.accent !== undefined) out.accent = brand.accent;
  if (brand.background !== undefined) out.bg = brand.background;
  if (brand.surface !== undefined) out.surface = brand.surface;
  if (brand.text !== undefined) out.fg = brand.text;
  if (brand.mutedText !== undefined) out.fgMuted = brand.mutedText;
  if (brand.fontFamily !== undefined) out.font = brand.fontFamily;
  if (brand.radius !== undefined)
    out.radius = typeof brand.radius === "number" ? `${brand.radius}px` : brand.radius;
  out.scheme = brand.mode === "dark" ? "dark" : "light";
  return out;
}

/** Host-tunable liquid character; absent knobs leave fluidkit's own defaults. */
export interface FluidConfig {
  material?: "glass" | "flat";
  intensity?: "whisper" | "present" | number;
}

/**
 * FlowletTheme (the host brand, already threaded from FlowletRoot) →
 * fluidkit's semantic theme. Near-1:1 by design — the token sets were made
 * congruent. Only set tokens map, honoring fluidkit's only-set-tokens-derive
 * rule; radius maps only when it's a plain px value (fluidkit radii are
 * numeric).
 */
export function brandToFluidTheme(theme: FlowletTheme | undefined, fluid?: FluidConfig): FluidTheme {
  const out: FluidTheme = {};
  if (!theme) theme = {};
  if (theme.accent !== undefined) out.accent = theme.accent;
  if (theme.surface !== undefined) out.surface = theme.surface;
  if (theme.fg !== undefined) out.text = theme.fg;
  if (theme.fgMuted !== undefined) out.mutedText = theme.fgMuted;
  if (theme.bg !== undefined) out.background = theme.bg;
  if (theme.font !== undefined) out.fontFamily = theme.font;
  if (theme.radius !== undefined) {
    const px = /^(\d+(?:\.\d+)?)px$/.exec(theme.radius.trim());
    if (px) out.radius = Number(px[1]);
  }
  if (theme.scheme === "light" || theme.scheme === "dark") out.mode = theme.scheme;
  if (fluid?.material !== undefined) out.material = fluid.material;
  if (fluid?.intensity !== undefined) out.intensity = fluid.intensity;
  return out;
}
