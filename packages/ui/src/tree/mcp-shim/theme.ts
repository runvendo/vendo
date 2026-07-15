import type { VendoTheme } from "@vendoai/core";
import { defaultVendoTheme } from "../../theme.js";

type CssVariables = Pick<CSSStyleDeclaration, "getPropertyValue">;

/** Rebuild the typed theme from the CSS transport used by the door. Keeping the
 * shim on variables (rather than embedded JSON) leaves the generated source
 * generic and gives its own chrome and the inner jail one canonical namespace. */
export function readThemeCssVariables(style: CssVariables): VendoTheme {
  const value = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;
  const optional = (name: string): string | undefined =>
    style.getPropertyValue(name).trim() || undefined;
  const density = optional("--vendo-density");
  const motion = optional("--vendo-motion");
  const headingFamily = optional("--vendo-heading-family") ?? defaultVendoTheme.typography.headingFamily;

  return {
    colors: {
      background: value("--vendo-color-background", defaultVendoTheme.colors.background),
      surface: value("--vendo-color-surface", defaultVendoTheme.colors.surface),
      text: value("--vendo-color-text", defaultVendoTheme.colors.text),
      muted: value("--vendo-color-muted", defaultVendoTheme.colors.muted),
      accent: value("--vendo-color-accent", defaultVendoTheme.colors.accent),
      accentText: value("--vendo-color-accent-text", defaultVendoTheme.colors.accentText),
      danger: value("--vendo-color-danger", defaultVendoTheme.colors.danger),
      border: value("--vendo-color-border", defaultVendoTheme.colors.border),
    },
    typography: {
      fontFamily: value("--vendo-font-family", defaultVendoTheme.typography.fontFamily),
      ...(headingFamily === undefined ? {} : { headingFamily }),
      baseSize: value("--vendo-font-size", defaultVendoTheme.typography.baseSize),
    },
    radius: {
      small: value("--vendo-radius-small", defaultVendoTheme.radius.small),
      medium: value("--vendo-radius-medium", defaultVendoTheme.radius.medium),
      large: value("--vendo-radius-large", defaultVendoTheme.radius.large),
    },
    density: density === "compact" || density === "comfortable" ? density : defaultVendoTheme.density,
    motion: motion === "full" || motion === "reduced" ? motion : defaultVendoTheme.motion,
  };
}
