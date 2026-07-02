/**
 * Cadence's single brand source of truth for Flowlet surfaces.
 *
 * Unlike demo-bank (whose hand-written brand.ts drifted from its own CSS —
 * see the ENG-197 fidelity report), Cadence treats the extractor artifact as
 * the runtime source: `.flowlet/theme.json` is validated against the frozen
 * BrandTokens schema at module load and fails the build loud if someone edits
 * it out of shape. The hand-verified values in that file mirror globals.css
 * (evergreen-600 accent, surface/card split, Hanken Grotesk).
 *
 * This one object feeds BOTH surfaces: the host shell (FlowletRoot's brand
 * vars + FlowletThemeProvider) and the generated-UI sandbox (SandboxStage's
 * brandToCssVars + mapBrandToTheme).
 */
// The React-free /theme entry: this module is imported by server routes, and
// the package root would drag the React component impls into the server build.
import { brandTokensSchema, type BrandTokens } from "@flowlet/components/theme";
import themeJson from "../../.flowlet/theme.json";

export const cadenceBrand: BrandTokens = brandTokensSchema.parse(themeJson);
