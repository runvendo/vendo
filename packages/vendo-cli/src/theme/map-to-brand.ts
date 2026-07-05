import { defaultBrand } from "@vendoai/components/theme";
import { manifestThemeSchema, type ManifestTheme } from "@vendoai/core";
import type { CssVarDecl } from "./css-vars.js";

export interface BrandMappingResult {
  /** Validated against the frozen manifestThemeSchema — the theme.json contract. */
  brand: ManifestTheme | null;
  /** slot -> winning var name, for the report */
  matched: Record<string, string>;
  /** BrandTokens slots that fell back to defaultBrand values */
  defaulted: string[];
  /** declarations we saw but did not use */
  unmapped: CssVarDecl[];
  hasDarkVariant: boolean;
}

const HEX = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

type ColorSlot = "accent" | "background" | "surface" | "text" | "mutedText";

/**
 * Ordered name fragments per slot. mutedText is matched before text so
 * "--color-muted" is not claimed by the text slot's looser fragments, and
 * exact-suffix matches beat loose-contains so "--color-ink" wins over
 * "--color-ink-soft". background's trailing "surface" fragment is a fallback:
 * token sets with no bg token (Cadence) use their surface color as the page
 * background, and the surface slot then falls through to card/panel.
 */
const COLOR_SLOTS: Array<{ slot: ColorSlot; fragments: string[] }> = [
  { slot: "accent", fragments: ["accent", "primary", "brand", "cta"] },
  { slot: "background", fragments: ["background", "-bg", "bg", "surface"] },
  { slot: "surface", fragments: ["surface", "card", "panel"] },
  { slot: "mutedText", fragments: ["fg-muted", "text-muted", "muted", "secondary-text"] },
  { slot: "text", fragments: ["-ink", "text", "-fg", "foreground"] },
];

/** Tailwind-style scale steps. */
const SCALE_STEPS = new Set([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]);
/** Scale families that are never the brand accent. */
const NON_ACCENT_FAMILY = /(gray|grey|neutral|slate|stone|zinc|status|success|warning|error|danger|info)/;

/**
 * Accent fallback for scale-named token sets (e.g. --color-evergreen-50..950):
 * when exactly one non-neutral, non-status hex scale exists, its mid step is
 * the brand accent. Zero or several candidate families is genuinely ambiguous
 * — return nothing and let the slot default (fail-closed).
 */
function pickScaleAccent(vars: CssVarDecl[]): CssVarDecl | undefined {
  const families = new Map<string, Map<number, CssVarDecl>>();
  for (const v of vars) {
    const m = v.name.match(/^(--[\w-]+?)-(\d{2,3})$/);
    if (!m || !m[1] || !m[2]) continue;
    const step = Number(m[2]);
    if (!SCALE_STEPS.has(step) || !HEX.test(v.value)) continue;
    const steps = families.get(m[1]) ?? new Map<number, CssVarDecl>();
    steps.set(step, v);
    families.set(m[1], steps);
  }
  const candidates = [...families.entries()].filter(
    ([name, steps]) => steps.size >= 3 && !NON_ACCENT_FAMILY.test(name),
  );
  if (candidates.length !== 1) return undefined;
  const steps = candidates[0]![1];
  const mid = [...steps.keys()].sort((a, b) => Math.abs(a - 500) - Math.abs(b - 500) || a - b)[0]!;
  return steps.get(mid);
}

function pick(
  vars: CssVarDecl[],
  fragments: string[],
  accept: (value: string) => boolean,
): CssVarDecl | undefined {
  for (const frag of fragments) {
    const bare = frag.replace(/^-/, "");
    const exact = vars.find(
      (v) => (v.name.endsWith(frag) || v.name === `--${bare}` || v.name === `--color-${bare}`) && accept(v.value),
    );
    if (exact) return exact;
    const loose = vars.find((v) => v.name.includes(frag) && accept(v.value));
    if (loose) return loose;
  }
  return undefined;
}

/**
 * Resolve `var(--x)` / `var(--x, fallback)` references against the collected
 * declarations (bounded depth). Returns null when a reference cannot be
 * resolved — theme.json carries fully-resolved primitives only (frozen theme
 * contract), so an unresolved font falls back to the default stack.
 */
export function resolveCssVarRefs(value: string, vars: CssVarDecl[], depth = 3): string | null {
  if (!value.includes("var(")) return value;
  if (depth <= 0) return null;
  const byName = new Map(vars.filter((v) => !v.darkScope).map((v) => [v.name, v.value]));
  const substituted = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]+))?\)/g, (_m, name: string, fallback?: string) => {
    return byName.get(name) ?? fallback?.trim() ?? "var()";
  });
  if (substituted.includes("var()")) return null; // unresolvable reference
  return resolveCssVarRefs(substituted, vars, depth - 1);
}

/** Fully-resolved font stack: no var() refs, no CSS structural characters. */
function isSafeFontStack(value: string): boolean {
  return value.length > 0 && !value.includes("var(") && !/[{};\n]/.test(value);
}

export function mapVarsToBrand(all: CssVarDecl[]): BrandMappingResult {
  const light = all.filter((v) => !v.darkScope);
  const hasDarkVariant = all.some((v) => v.darkScope);
  const used = new Set<CssVarDecl>();
  const matched: Record<string, string> = {};
  const defaulted: string[] = [];
  const draft: Record<string, unknown> = { version: 1, mode: "light" };

  // "X-bg" alongside a declared "X" is a tinted companion of X (badge/status
  // backgrounds like --color-status-missing-bg), never the page background.
  const names = new Set(light.map((v) => v.name));
  const isCompanionBg = (v: CssVarDecl) => v.name.endsWith("-bg") && names.has(v.name.slice(0, -"-bg".length));

  for (const { slot, fragments } of COLOR_SLOTS) {
    let candidates = light.filter((v) => !used.has(v));
    if (slot === "background") candidates = candidates.filter((v) => !isCompanionBg(v));
    let hit = pick(candidates, fragments, (val) => HEX.test(val));
    if (!hit && slot === "accent") hit = pickScaleAccent(candidates);
    if (hit) { used.add(hit); matched[slot] = hit.name; draft[slot] = hit.value; }
    else { defaulted.push(slot); draft[slot] = defaultBrand[slot]; }
  }

  const radius = pick(light, ["radius"], (val) => /^\d+(\.\d+)?px$/.test(val));
  if (radius) { used.add(radius); matched["radius"] = radius.name; draft["radius"] = radius.value; }
  else { defaulted.push("radius"); draft["radius"] = defaultBrand.radius; }

  const font = pick(
    light,
    ["font-sans", "font-family", "font"],
    (val) => resolveCssVarRefs(val, all) !== null && isSafeFontStack(resolveCssVarRefs(val, all)!),
  );
  if (font) {
    used.add(font);
    matched["fontFamily"] = font.name;
    draft["fontFamily"] = resolveCssVarRefs(font.value, all)!;
  } else {
    defaulted.push("fontFamily");
    draft["fontFamily"] = defaultBrand.fontFamily;
  }

  const parsed = manifestThemeSchema.safeParse(draft);
  return {
    brand: parsed.success ? parsed.data : null,
    matched,
    defaulted,
    unmapped: light.filter((v) => !used.has(v)),
    hasDarkVariant,
  };
}
