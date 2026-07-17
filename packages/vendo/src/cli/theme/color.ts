import type { CssVarDecl } from "./css-vars.js";

/**
 * Deterministic CSS color/length normalization for exact token reads. Every
 * conversion here is published spec math (CSS Color 4), not inference: a
 * conventional token's declared value is turned into the concrete hex/px the
 * frozen VendoTheme contract carries. Values with real transparency are
 * rejected (theme slots are opaque paints), as is anything unparseable —
 * an unreadable value is treated as absent, never guessed at.
 */

const HEX = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

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

/** `hsl()`/`hsla()` plus the bare shadcn triplet form (`222.2 47.4% 11.2%`). */
function parseHsl(value: string): string | null {
  const trimmed = value.trim();
  const fn = trimmed.match(/^hsla?\(([\s\S]+)\)$/i);
  const body = fn?.[1]?.trim() ?? trimmed;
  const slashParts = body.split("/");
  if (slashParts.length > 2) return null;
  const rawParts = slashParts[0]!.includes(",")
    ? slashParts[0]!.split(",").map((part) => part.trim())
    : slashParts[0]!.trim().split(/\s+/);
  const alpha = parseAlpha(slashParts[1] ?? (rawParts.length === 4 ? rawParts[3] : undefined));
  if (!Number.isFinite(alpha) || alpha < 0.999) return null;
  const parts = rawParts.slice(0, 3);
  if (parts.length !== 3 || !parts[1]?.endsWith("%") || !parts[2]?.endsWith("%")) return null;
  const hue = Number(parts[0]);
  const saturation = Number(parts[1].slice(0, -1));
  const lightness = Number(parts[2].slice(0, -1));
  if (![hue, saturation, lightness].every(Number.isFinite)) return null;
  return hslToHex(hue, saturation, lightness);
}

/** Bare space-separated `R G B` byte triplet (Tailwind `rgb(var(--x)) `style). */
function parseRgbTriplet(value: string): string | null {
  const body = value.trim().replace(/^rgba?\(([\s\S]+)\)$/i, "$1");
  const slashParts = body.split("/");
  if (slashParts.length > 2) return null;
  const alpha = parseAlpha(slashParts[1]);
  if (!Number.isFinite(alpha) || alpha < 0.999) return null;
  const parts = slashParts[0]!.trim().split(/[\s,]+/);
  if (parts.length !== 3 || parts.some((part) => part.endsWith("%"))) return null;
  const channels = parts.map((part) => Number(part));
  if (channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) return null;
  return `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function linearToSrgb(value: number): number {
  const v = clamp01(value);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** CSS Color 4 §"OKLCH" — the spec's published OKLab→sRGB constants. */
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

/** Any supported CSS color form to lowercase 6-digit hex; null when not one. */
export function normalizeColor(value: string): string | null {
  return normalizeHex(value) ?? parseRgbTriplet(value) ?? parseHsl(value) ?? parseOklch(value);
}

/**
 * Resolve `var(--x)` / `var(--x, fallback)` references against the collected
 * declarations (bounded depth). Returns null when a reference cannot be
 * resolved — theme.json carries fully-resolved primitives only (frozen theme
 * contract), so an unresolved reference means the slot is not exactly readable.
 */
export function resolveCssVarRefs(value: string, vars: CssVarDecl[], depth = 6): string | null {
  if (!value.includes("var(")) return value;
  if (depth <= 0) return null;
  const byName = new Map(vars.filter((v) => !v.darkScope).map((v) => [v.name, v.value]));
  const substituted = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]+))?\)/g, (_m, name: string, fallback?: string) => {
    return byName.get(name) ?? fallback?.trim() ?? "var()";
  });
  if (substituted.includes("var()")) return null; // unresolvable reference
  return resolveCssVarRefs(substituted, vars, depth - 1);
}

/** px/rem length to canonical px; null for any other unit or expression. */
export function normalizeLength(value: string): string | null {
  const trimmed = value.trim();
  const px = trimmed.match(/^((?:\d+|\d*\.\d+))px$/);
  if (px) return `${Number(px[1])}px`;
  const rem = trimmed.match(/^((?:\d+|\d*\.\d+))rem$/);
  if (rem) return `${Number(rem[1]) * 16}px`;
  return null;
}

function relativeLuminance(hex: string): number {
  const normalized = normalizeHex(hex);
  if (!normalized) return 0;
  const channels = [1, 3, 5].map((index) => parseInt(normalized.slice(index, index + 2), 16) / 255);
  const [r, g, b] = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Pick black or white by the larger WCAG contrast ratio against the accent. */
export function contrastingText(accent: string): "#000000" | "#ffffff" {
  const luminance = relativeLuminance(accent);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? "#000000" : "#ffffff";
}
