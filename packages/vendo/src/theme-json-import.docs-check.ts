/**
 * The provider paste every quickstart publishes — compiled.
 *
 * `docs-site/product/quickstart.mdx` (and mount-the-surface, theming, agents)
 * shows `import theme from "../.vendo/theme.json"` handed straight to the
 * provider's `theme` prop. A bundler types a JSON module by WIDENING every
 * string literal, so `density`, `motion` and `typography.fonts[].source`
 * arrive as plain `string`; the docs used to carry an `as VendoTheme` cast to
 * paper over that. `VendoTheme` now widens those three fields with
 * `| (string & {})` instead, and this file is the proof the paste compiles
 * with no cast — drop either arm and it is a TS2322.
 */
import type { ComponentProps } from "react";
import type { VendoProvider } from "./react.js";

/** What a bundler infers for `import theme from "./.vendo/theme.json"`: the
 *  shape `vendo init` writes, with every string literal widened. */
declare const theme: {
  colors: {
    background: string;
    surface: string;
    text: string;
    muted: string;
    accent: string;
    accentText: string;
    danger: string;
    border: string;
  };
  typography: {
    fontFamily: string;
    baseSize: string;
    fonts: { family: string; weight: string; style: string; source: string }[];
  };
  radius: { small: string; medium: string; large: string };
  density: string;
  motion: string;
};

export const quickstartThemeProp: ComponentProps<typeof VendoProvider>["theme"] = theme;
