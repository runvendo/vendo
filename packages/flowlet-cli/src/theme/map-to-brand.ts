import { defaultBrand } from "@flowlet/components/theme";
import { manifestThemeSchema, type ManifestTheme } from "@flowlet/core";
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
 * "--color-ink-soft".
 */
const COLOR_SLOTS: Array<{ slot: ColorSlot; fragments: string[] }> = [
  { slot: "accent", fragments: ["accent", "primary", "brand", "cta"] },
  { slot: "background", fragments: ["background", "-bg", "bg"] },
  { slot: "surface", fragments: ["surface", "card", "panel"] },
  { slot: "mutedText", fragments: ["fg-muted", "text-muted", "muted", "secondary-text"] },
  { slot: "text", fragments: ["-ink", "text", "-fg", "foreground"] },
];

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

  for (const { slot, fragments } of COLOR_SLOTS) {
    const hit = pick(light.filter((v) => !used.has(v)), fragments, (val) => HEX.test(val));
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
