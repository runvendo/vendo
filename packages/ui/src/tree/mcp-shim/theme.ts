import {
  VENDO_THEME_VARIABLE_NAMES,
  defaultVendoTheme,
  type VendoTheme,
} from "@vendoai/apps/contract";

type CssVariables = Pick<CSSStyleDeclaration, "getPropertyValue">;

/** The read side of core's one theme→CSS-variable mapping: a name this reader
 * asks for must be a name that mapping emits. Without the check a rename on the
 * write side degrades every themed MCP App to the neutral default in silence —
 * the reader would just never find its variable. */
function emitted(name: string): string {
  if (!VENDO_THEME_VARIABLE_NAMES.includes(name)) {
    throw new Error(`[vendo] ${name} is not emitted by themeCssVariables; the MCP shim theme reader is out of sync`);
  }
  return name;
}

/** Rebuild the typed theme from the CSS transport used by the door. Keeping the
 * shim on variables (rather than embedded JSON) leaves the generated source
 * generic and gives its own chrome and the inner jail one canonical namespace.
 * Only the variables a `VendoTheme` field maps back from are read; the derived
 * ones (color-scheme, the density sizing scale, motion timings) are the
 * mapping's output, not its input. */
export function readThemeCssVariables(style: CssVariables): VendoTheme {
  const value = (name: string, fallback: string): string =>
    style.getPropertyValue(emitted(name)).trim() || fallback;
  const optional = (name: string): string | undefined =>
    style.getPropertyValue(emitted(name)).trim() || undefined;
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
