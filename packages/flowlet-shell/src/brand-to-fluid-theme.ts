import type { FluidTheme } from "fluidkit";
import type { FlowletTheme } from "./theme";

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
