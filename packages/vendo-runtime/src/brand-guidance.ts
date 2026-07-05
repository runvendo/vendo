/**
 * buildBrandGuidance — a data-driven system-prompt section that teaches the
 * model the HOST's brand, generated entirely from the theme tokens the host
 * already ships (the `--vendo-*` CSS-var map, ultimately produced from the
 * manifest's theme by `brandToCssVars`) plus optional host-authored norms.
 *
 * Host-agnostic by construction: this module contains no brand names, no
 * colors, and no prose about any particular product — it renders whatever
 * tokens and norms it is fed. Point it at a different host's manifest and the
 * guidance follows.
 */

/** Optional host-authored style norms, written by the host developer (or one
 *  day extracted). Free-form strings — included verbatim in the prompt. */
export interface HostBrandNorms {
  /** Layout density and whitespace character, e.g. "calm, generous, one idea per card". */
  density?: string;
  /** Voice for microcopy in generated UI, e.g. "quiet confidence, no exclamation marks". */
  tone?: string;
  /** Spacing rhythm hints, e.g. "16px card padding, 12px between rows". */
  spacing?: string;
  /** Chart conventions, e.g. "monochrome bars, no gridlines, labels outside". */
  charts?: string;
}

export interface BrandGuidanceInput {
  /** The `--vendo-*` CSS-var map injected into the render surface (name → resolved value). */
  tokens: Record<string, string>;
  /** Optional host-authored norms, included verbatim under a norms block. */
  norms?: HostBrandNorms;
}

const NORM_LABELS: Record<keyof HostBrandNorms, string> = {
  density: "Layout",
  tone: "Copy tone",
  spacing: "Spacing",
  charts: "Charts",
};

/** Render the BRAND section of the system prompt from token data + norms. */
export function buildBrandGuidance({ tokens, norms }: BrandGuidanceInput): string {
  const tokenLines = Object.entries(tokens).map(([name, value]) => `- ${name}: ${value}`);

  const normLines = norms
    ? (Object.keys(NORM_LABELS) as (keyof HostBrandNorms)[])
        .filter((k) => norms[k])
        .map((k) => `- ${NORM_LABELS[k]}: ${norms[k]}`)
    : [];

  return [
    "BRAND — every view you render must look like the HOST APP built it, not like",
    "generic AI output. The host's design tokens are injected as CSS variables in",
    "the render surface; their current values:",
    ...tokenLines,
    "Rules:",
    "- In novel (generated) components, style with the variables — e.g.",
    "  color: 'var(--vendo-fg)', background: 'var(--vendo-surface)',",
    "  accent elements var(--vendo-accent), secondary text var(--vendo-fg-muted),",
    "  borders var(--vendo-border), corner rounding var(--vendo-radius).",
    "  DO NOT hardcode your own palette (no Tailwind grays, no indigo/purple defaults).",
    "- Never use gradients, emoji, or decorative flourishes the token set does not imply.",
    "- Typography comes from the surface (var(--vendo-font) is already applied);",
    "  do not set font families. Use font weight and size for hierarchy, sparingly.",
    "- Prefer the catalog components — they are pre-themed to these tokens. Reach for",
    "  a novel component only when the catalog cannot express the request.",
    "- Use the exact literal values above ONLY when a CSS variable cannot be used",
    "  (e.g. an SVG fill attribute); otherwise always reference the variable.",
    ...(normLines.length ? ["Host style norms (follow these):", ...normLines] : []),
  ].join("\n");
}
