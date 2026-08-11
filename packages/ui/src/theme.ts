/**
 * The theme mapping now lives in `@vendoai/core` (`packages/core/src/theme.ts`)
 * so the chrome, the MCP door's pages and the MCP Apps shim all serialize ONE
 * definition instead of three hand-kept copies. This re-export keeps ui's
 * published surface byte-identical.
 */
export {
  colorSchemeForBackground,
  defaultVendoTheme,
  resolveTheme,
  themeCssVariables,
} from "@vendoai/apps/contract";
