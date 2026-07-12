import type { CSSProperties } from "react";

export type VendoScheme = "light" | "dark" | "auto";

export interface VendoTheme {
  accent?: string;
  accentFg?: string;
  fg?: string;
  fgMuted?: string;
  bg?: string;
  surface?: string;
  border?: string;
  radius?: string;
  shadow?: string;
  font?: string;
  fontMono?: string;
  scheme?: VendoScheme;
}

const TOKEN_VARS: Record<Exclude<keyof VendoTheme, "scheme">, string> = {
  accent: "--vendo-accent",
  accentFg: "--vendo-accent-fg",
  fg: "--vendo-fg",
  fgMuted: "--vendo-fg-muted",
  bg: "--vendo-bg",
  surface: "--vendo-surface",
  border: "--vendo-border",
  radius: "--vendo-radius",
  shadow: "--vendo-shadow",
  font: "--vendo-font",
  fontMono: "--vendo-font-mono",
};

/** Maps a partial theme to inline CSS custom properties + colorScheme. */
export function themeToStyle(theme: VendoTheme = {}): CSSProperties {
  const style: Record<string, string> = {};
  for (const key of Object.keys(TOKEN_VARS) as (keyof typeof TOKEN_VARS)[]) {
    const value = theme[key];
    if (value !== undefined) style[TOKEN_VARS[key]] = value;
  }
  if (theme.scheme && theme.scheme !== "auto") style.colorScheme = theme.scheme;
  if (theme.scheme === "auto") style.colorScheme = "light dark";
  return style as CSSProperties;
}
