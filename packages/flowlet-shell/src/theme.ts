import type { CSSProperties } from "react";

export type FlowletScheme = "light" | "dark" | "auto";

export interface FlowletTheme {
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
  scheme?: FlowletScheme;
}

const TOKEN_VARS: Record<Exclude<keyof FlowletTheme, "scheme">, string> = {
  accent: "--flowlet-accent",
  accentFg: "--flowlet-accent-fg",
  fg: "--flowlet-fg",
  fgMuted: "--flowlet-fg-muted",
  bg: "--flowlet-bg",
  surface: "--flowlet-surface",
  border: "--flowlet-border",
  radius: "--flowlet-radius",
  shadow: "--flowlet-shadow",
  font: "--flowlet-font",
  fontMono: "--flowlet-font-mono",
};

/** Maps a partial theme to inline CSS custom properties + colorScheme. */
export function themeToStyle(theme: FlowletTheme = {}): CSSProperties {
  const style: Record<string, string> = {};
  for (const key of Object.keys(TOKEN_VARS) as (keyof typeof TOKEN_VARS)[]) {
    const value = theme[key];
    if (value !== undefined) style[TOKEN_VARS[key]] = value;
  }
  if (theme.scheme && theme.scheme !== "auto") style.colorScheme = theme.scheme;
  if (theme.scheme === "auto") style.colorScheme = "light dark";
  return style as CSSProperties;
}
