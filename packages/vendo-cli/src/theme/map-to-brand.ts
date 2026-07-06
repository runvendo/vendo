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
 * "--color-ink-soft".
 */
const COLOR_SLOTS: Array<{ slot: ColorSlot; fragments: string[] }> = [
  { slot: "accent", fragments: ["primary", "brand", "cta", "accent"] },
  { slot: "background", fragments: ["background", "surface-raised", "-bg", "bg"] },
  { slot: "surface", fragments: ["surface-base", "surface", "card", "panel"] },
  { slot: "mutedText", fragments: ["muted-foreground", "fg-muted", "text-muted", "muted-text", "secondary-text", "muted"] },
  { slot: "text", fragments: ["text-primary", "foreground", "-ink", "text", "-fg"] },
];

/** Tailwind-style scale steps. */
const SCALE_STEPS = new Set([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]);
/** Scale families that are never the brand accent. */
const NON_ACCENT_FAMILY = /(gray|grey|neutral|slate|stone|zinc|status|success|warning|error|danger|info)/;

/** Spread between the widest RGB channels — near zero for neutral ramps whose
 * family name isn't on the keyword list (sand, ash, ivory, ...). */
function hexChroma(hex: string): number {
  let h = normalizeHex(hex)?.slice(1) ?? hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/**
 * Accent fallback for scale-named token sets (e.g. --color-evergreen-50..950):
 * when exactly one non-neutral, non-status hex scale exists, its mid step is
 * the brand accent. Zero or several candidate families, or a mid step too
 * gray to be a brand color, is genuinely ambiguous — return nothing and let
 * the slot default (fail-closed).
 */
function pickScaleAccent(vars: CssVarDecl[]): CssVarDecl | undefined {
  const families = new Map<string, Map<number, CssVarDecl>>();
  for (const v of vars) {
    const m = v.name.match(/^(--[\w-]+?)-(\d{2,3})$/);
    if (!m || !m[1] || !m[2]) continue;
    const step = Number(m[2]);
    if (!SCALE_STEPS.has(step) || !normalizeColor(v.value)) continue;
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
  const hit = steps.get(mid);
  const color = hit ? normalizeColor(hit.value) : null;
  return hit && color && hexChroma(color) >= 32 ? hit : undefined;
}

function normalizeHex(value: string): string | null {
  const trimmed = value.trim();
  if (!HEX.test(trimmed)) return null;
  let h = trimmed.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length === 8) {
    const alpha = parseInt(h.slice(6, 8), 16);
    if (alpha !== 255) return null;
    h = h.slice(0, 6);
  }
  return `#${h.slice(0, 6).toLowerCase()}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function byteToHex(value: number): string {
  return Math.round(clamp01(value) * 255).toString(16).padStart(2, "0");
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}`;
}

function parseAlpha(value: string | undefined): number {
  if (!value) return 1;
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) return Number(trimmed.slice(0, -1)) / 100;
  return Number(trimmed);
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const h = (((hue % 360) + 360) % 360) / 360;
  const s = clamp01(saturation / 100);
  const l = clamp01(lightness / 100);
  if (s === 0) return rgbToHex(l, l, l);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (offset: number) => {
    let t = h + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return rgbToHex(channel(1 / 3), channel(0), channel(-1 / 3));
}

function parseHsl(value: string): string | null {
  const trimmed = value.trim();
  const body = trimmed.startsWith("hsl(") && trimmed.endsWith(")") ? trimmed.slice(4, -1).trim() : trimmed;
  const slashParts = body.split("/");
  if (slashParts.length > 2) return null;
  const alpha = parseAlpha(slashParts[1]);
  if (!Number.isFinite(alpha) || alpha < 0.999) return null;
  const parts = slashParts[0]!.includes(",")
    ? slashParts[0]!.split(",").map((part) => part.trim())
    : slashParts[0]!.trim().split(/\s+/);
  if (parts.length !== 3 || !parts[1]?.endsWith("%") || !parts[2]?.endsWith("%")) return null;
  const hue = Number(parts[0]);
  const saturation = Number(parts[1].slice(0, -1));
  const lightness = Number(parts[2].slice(0, -1));
  if (![hue, saturation, lightness].every(Number.isFinite)) return null;
  return hslToHex(hue, saturation, lightness);
}

function linearToSrgb(value: number): number {
  const v = clamp01(value);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function parseOklch(value: string): string | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^oklch\(\s*([+-]?(?:\d+|\d*\.\d+)%?)\s+([+-]?(?:\d+|\d*\.\d+))\s+([+-]?(?:\d+|\d*\.\d+)(?:deg)?)\s*(?:\/\s*([^)]+))?\)$/i);
  if (!match) return null;
  const alpha = parseAlpha(match[4]);
  if (!Number.isFinite(alpha) || alpha < 0.999) return null;
  const lRaw = match[1]!;
  const lightness = lRaw.endsWith("%") ? Number(lRaw.slice(0, -1)) / 100 : Number(lRaw);
  const chroma = Number(match[2]);
  const hue = Number(match[3]!.replace(/deg$/i, ""));
  if (![lightness, chroma, hue].every(Number.isFinite)) return null;

  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  return rgbToHex(
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  );
}

function normalizeColor(value: string): string | null {
  return normalizeHex(value) ?? parseHsl(value) ?? parseOklch(value);
}

function normalizeColorVar(value: string, all: CssVarDecl[]): string | null {
  const resolved = resolveCssVarRefs(value, all, 6);
  return resolved ? normalizeColor(resolved) : null;
}

function normalizeRadius(value: string, all: CssVarDecl[]): string | null {
  const resolved = resolveCssVarRefs(value, all, 6)?.trim();
  if (!resolved) return null;
  const px = resolved.match(/^((?:\d+|\d*\.\d+))px$/);
  if (px) return `${Number(px[1])}px`;
  const rem = resolved.match(/^((?:\d+|\d*\.\d+))rem$/);
  if (rem) return `${Number(rem[1]) * 16}px`;
  return null;
}

const EMOJI_FONT_FALLBACKS = new Set([
  "apple color emoji",
  "segoe ui emoji",
  "segoe ui symbol",
  "noto color emoji",
]);

const REDUNDANT_SYSTEM_FONT_FALLBACKS = new Set([
  "-apple-system",
  "blinkmacsystemfont",
  "segoe ui",
  "roboto",
  "helvetica neue",
  "arial",
  "noto sans",
]);

function normalizeFontStack(value: string): string {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part, index) => {
      const normalized = part.replace(/^["']|["']$/g, "").toLowerCase();
      if (EMOJI_FONT_FALLBACKS.has(normalized)) return false;
      return index === 0 || !REDUNDANT_SYSTEM_FONT_FALLBACKS.has(normalized);
    })
    .join(", ");
}

function matchStrength(name: string, fragment: string): number {
  const bare = fragment.replace(/^-/, "");
  if (name === `--${bare}` || name === `--color-${bare}`) return 4;
  if (fragment.startsWith("-") && name.endsWith(fragment)) return 3;
  if (name.endsWith(`-${bare}`)) return 2;
  return name.includes(fragment) ? 1 : 0;
}

function pick(
  vars: CssVarDecl[],
  fragments: string[],
  accept: (value: string) => boolean,
): CssVarDecl | undefined {
  for (const frag of fragments) {
    let best: { value: CssVarDecl; strength: number; index: number } | null = null;
    for (let index = 0; index < vars.length; index += 1) {
      const v = vars[index]!;
      const strength = matchStrength(v.name, frag);
      if (strength === 0 || !accept(v.value)) continue;
      if (!best || strength > best.strength || (strength === best.strength && index > best.index)) {
        best = { value: v, strength, index };
      }
    }
    if (best) return best.value;
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
  // Synthetic decls (next/font recovery) resolve var() chains only — slots
  // pick from CSS-declared vars.
  const light = all.filter((v) => !v.darkScope && !v.synthetic);
  const hasDarkVariant = all.some((v) => v.darkScope);
  const used = new Set<CssVarDecl>();
  const matched: Record<string, string> = {};
  const defaulted: string[] = [];
  const draft: Record<string, unknown> = { version: 1, mode: "light" };

  // "X-bg" alongside a declared "X" (or "X-fg") is a tinted companion of X
  // (badge/status backgrounds like --color-status-missing-bg), never a slot
  // color in its own right.
  const names = new Set(light.map((v) => v.name));
  const isCompanionTint = (v: CssVarDecl) => {
    if (!v.name.endsWith("-bg")) return false;
    const base = v.name.slice(0, -"-bg".length);
    return names.has(base) || names.has(`${base}-fg`);
  };

  for (const { slot, fragments } of COLOR_SLOTS) {
    const candidates = light.filter((v) => !used.has(v) && !isCompanionTint(v));
    let hit = pick(candidates, fragments, (value) => normalizeColorVar(value, all) !== null);
    if (!hit && slot === "accent") hit = pickScaleAccent(candidates);
    if (!hit && slot === "background") {
      // Token sets with no bg token (Cadence) use their surface color as the
      // page background — but only promote it when the surface slot keeps a
      // candidate of its own, else we'd trade one wrong slot for two.
      const surface = pick(candidates, ["surface"], (value) => normalizeColorVar(value, all) !== null);
      if (surface && pick(candidates.filter((v) => v !== surface), ["surface", "card", "panel"], (value) => normalizeColorVar(value, all) !== null)) {
        hit = surface;
      }
    }
    if (hit) { used.add(hit); matched[slot] = hit.name; draft[slot] = normalizeColorVar(hit.value, all)!; }
    else { defaulted.push(slot); draft[slot] = defaultBrand[slot]; }
  }

  const radius = pick(light, ["radius-default", "radius-card", "radius"], (val) => normalizeRadius(val, all) !== null);
  if (radius) { used.add(radius); matched["radius"] = radius.name; draft["radius"] = normalizeRadius(radius.value, all)!; }
  else { defaulted.push("radius"); draft["radius"] = defaultBrand.radius; }

  const font = pick(
    light,
    ["font-sans", "font-family", "font"],
    (val) => resolveCssVarRefs(val, all) !== null && isSafeFontStack(resolveCssVarRefs(val, all)!),
  );
  if (font) {
    used.add(font);
    matched["fontFamily"] = font.name;
    draft["fontFamily"] = normalizeFontStack(resolveCssVarRefs(font.value, all)!);
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
