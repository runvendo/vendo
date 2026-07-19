/**
 * Theme-editor state helpers: presets, the `?theme=` URL codec, font-stack
 * utilities, and the `.vendo/theme.json` emitter. Pure module — the panel
 * component (theme-editor.tsx) renders it; nothing here touches the DOM.
 */
import { vendoThemeSchema, type VendoTheme } from "@vendoai/core";
import { defaultVendoTheme, resolveTheme } from "@vendoai/ui";

export interface ThemePreset {
  name: string;
  theme: VendoTheme;
}

/** Default black leads (the Cadence-extracted look Yousef calls the default);
 * Ultramarine is the shipped defaultVendoTheme; the rest are stress presets —
 * one dark (color-scheme flip) and one radius/type torture test. */
export const themePresets: ThemePreset[] = [
  {
    name: "Default black",
    theme: {
      colors: {
        background: "#fbfbfa",
        surface: "#ffffff",
        text: "#111111",
        muted: "#46443f",
        accent: "#111111",
        accentText: "#ffffff",
        danger: "#b0473a",
        border: "#ecebe8",
      },
      typography: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", baseSize: "15px" },
      radius: { small: "6px", medium: "12px", large: "12px" },
      density: "comfortable",
      motion: "full",
    },
  },
  {
    // The pre-black-default shipped look, kept as an accent stress preset.
    name: "Ultramarine",
    theme: {
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
      typography: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", baseSize: "15px" },
      radius: { small: "6px", medium: "10px", large: "16px" },
      density: "comfortable",
      motion: "full",
    },
  },
  {
    name: "Dark violet",
    theme: {
      colors: {
        background: "#0f1116",
        surface: "#171a21",
        text: "#e8e9ee",
        muted: "#9aa0ae",
        accent: "#7c6cff",
        accentText: "#ffffff",
        danger: "#ff6b5e",
        border: "#262a34",
      },
      typography: { fontFamily: "Onest, system-ui, sans-serif", baseSize: "15px" },
      radius: { small: "6px", medium: "10px", large: "16px" },
      density: "comfortable",
      motion: "full",
    },
  },
  {
    name: "Playful round",
    theme: {
      colors: {
        background: "#fffdf6",
        surface: "#ffffff",
        text: "#1c1917",
        muted: "#78716c",
        accent: "#ff5c38",
        accentText: "#ffffff",
        danger: "#c62f2f",
        border: "#ede5d8",
      },
      typography: { fontFamily: "Onest, system-ui, sans-serif", baseSize: "16px" },
      radius: { small: "10px", medium: "16px", large: "24px" },
      density: "compact",
      motion: "full",
    },
  },
];

/** Serialize a theme for the shareable `?theme=` search param. */
export function encodeThemeParam(theme: VendoTheme): string {
  return JSON.stringify(theme);
}

/** Parse a `?theme=` payload: partials resolve over the shipped defaults, and
 * anything that does not validate as a VendoTheme is dropped (undefined). */
export function decodeThemeParam(value: string | null): VendoTheme | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const resolved = resolveTheme(defaultVendoTheme, parsed as Partial<VendoTheme>);
  return vendoThemeSchema.safeParse(resolved).success ? resolved : undefined;
}

/** The font picker's curated list; anything else arrives via free text. */
export const curatedFonts = ["Onest", "Inter", "Geist", "IBM Plex Sans", "Newsreader", "system-ui (no webfont)"];

/** Families that must never be fetched from Google Fonts. */
const SYSTEM_FAMILIES = new Set([
  "system-ui",
  "system-ui (no webfont)",
  "-apple-system",
  "blinkmacsystemfont",
  "segoe ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "sans-serif",
  "serif",
  "monospace",
]);

/** First family of a CSS font stack, unquoted. */
export function primaryFontFamily(fontFamily: string): string {
  const first = fontFamily.split(",")[0]!.trim();
  return first.replace(/^['"]|['"]$/g, "");
}

/** Google Fonts css2 href for a webfont family; undefined for system fonts. */
export function googleFontHref(family: string): string | undefined {
  const name = family.trim();
  if (!name || SYSTEM_FAMILIES.has(name.toLowerCase())) return undefined;
  return `https://fonts.googleapis.com/css2?family=${name.replace(/ /g, "+")}:wght@400;500;600;700&display=swap`;
}

/** Full fontFamily token for a picked family, quoting multi-word names. */
export function fontStack(family: string): string {
  const name = family.trim();
  if (!name || name.toLowerCase().startsWith("system-ui")) {
    return "system-ui, -apple-system, 'Segoe UI', sans-serif";
  }
  const quoted = name.includes(" ") ? `'${name}'` : name;
  return `${quoted}, system-ui, sans-serif`;
}

/** Pretty-printed `.vendo/theme.json` document for the current theme. */
export function themeJson(theme: VendoTheme): string {
  return `${JSON.stringify(theme, null, 2)}\n`;
}
