import {
  VENDO_THEME_VARIABLE_NAMES,
  chartPaletteFor,
  defaultVendoTheme,
  themeDefaults,
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
 * ones (color-scheme, the density sizing scale, the duplicate base size) are the
 * mapping's output, not its input. */
export function readThemeCssVariables(style: CssVariables): VendoTheme {
  const value = (name: string, fallback: string): string =>
    style.getPropertyValue(emitted(name)).trim() || fallback;
  const optional = (name: string): string | undefined =>
    style.getPropertyValue(emitted(name)).trim() || undefined;
  /** A field the contract marks optional. The mapping emits its variable whatever
   * vintage the host's theme file is, filling in `themeDefaults`, so recovering
   * one whose value still IS that fill-in would turn a theme that declared none
   * of them into a theme that declares them all. Recovered only when it differs. */
  const override = <K extends string>(field: K, name: string, fallback: string): { [P in K]?: string } => {
    const read = value(name, fallback);
    return read === fallback ? {} : { [field]: read } as { [P in K]?: string };
  };
  const density = optional("--vendo-density");
  const motion = optional("--vendo-motion");
  const headingFamily = optional("--vendo-heading-family") ?? defaultVendoTheme.typography.headingFamily;
  const accent = value("--vendo-color-accent", defaultVendoTheme.colors.accent);
  const shadow = {
    small: value("--vendo-shadow-small", themeDefaults.shadow.small),
    medium: value("--vendo-shadow-medium", themeDefaults.shadow.medium),
    large: value("--vendo-shadow-large", themeDefaults.shadow.large),
  };
  // The mapping fills the six series from the accent's ramp, so a palette equal
  // to that ramp is one the host never declared.
  const chartRamp = chartPaletteFor(accent).slice(0, 6);
  const chartPalette = chartRamp.map((fallback, i) => value(`--vendo-chart-${i + 1}`, fallback));

  return {
    colors: {
      background: value("--vendo-color-background", defaultVendoTheme.colors.background),
      surface: value("--vendo-color-surface", defaultVendoTheme.colors.surface),
      text: value("--vendo-color-text", defaultVendoTheme.colors.text),
      muted: value("--vendo-color-muted", defaultVendoTheme.colors.muted),
      accent,
      accentText: value("--vendo-color-accent-text", defaultVendoTheme.colors.accentText),
      danger: value("--vendo-color-danger", defaultVendoTheme.colors.danger),
      border: value("--vendo-color-border", defaultVendoTheme.colors.border),
      ...override("success", "--vendo-color-success", themeDefaults.colors.success),
      ...override("warning", "--vendo-color-warning", themeDefaults.colors.warning),
      ...override("surfaceRaised", "--vendo-color-surface-raised", themeDefaults.colors.surfaceRaised),
    },
    typography: {
      fontFamily: value("--vendo-font-family", defaultVendoTheme.typography.fontFamily),
      ...(headingFamily === undefined ? {} : { headingFamily }),
      ...override("monoFamily", "--vendo-mono-family", themeDefaults.typography.monoFamily),
      baseSize: value("--vendo-font-size", defaultVendoTheme.typography.baseSize),
      ...override("weightNormal", "--vendo-font-weight-normal", themeDefaults.typography.weightNormal),
      ...override("weightEmphasis", "--vendo-font-weight-emphasis", themeDefaults.typography.weightEmphasis),
      ...override("letterSpacing", "--vendo-letter-spacing", themeDefaults.typography.letterSpacing),
      ...override("lineHeightBody", "--vendo-line-height", themeDefaults.typography.lineHeightBody),
      ...override("lineHeightHeading", "--vendo-line-height-heading", themeDefaults.typography.lineHeightHeading),
    },
    radius: {
      small: value("--vendo-radius-small", defaultVendoTheme.radius.small),
      medium: value("--vendo-radius-medium", defaultVendoTheme.radius.medium),
      large: value("--vendo-radius-large", defaultVendoTheme.radius.large),
    },
    ...(JSON.stringify(shadow) === JSON.stringify(themeDefaults.shadow) ? {} : { shadow }),
    density: density === "compact" || density === "comfortable" ? density : defaultVendoTheme.density,
    motion: motion === "full" || motion === "reduced" ? motion : defaultVendoTheme.motion,
    ...override("borderWidth", "--vendo-border-width", themeDefaults.borderWidth),
    ...(chartPalette.join() === chartRamp.join() ? {} : { chartPalette }),
    // A reduced-motion theme is emitted with its duration zeroed, so 0ms there is
    // the mapping's own output, not a host's declaration.
    ...override("motionDuration", "--vendo-motion-duration",
      motion === "reduced" ? "0ms" : themeDefaults.motionDuration),
    ...override("motionEasing", "--vendo-motion-easing", themeDefaults.motionEasing),
  };
}
