/** @vendoai/ui — provider, hooks, client (headless, no styles). docs/contracts/08-ui.md */
export { createVendoClient, type VendoClient, type VendoClientConfig } from "./client.js";
export { VendoProvider, useVendoTheme } from "./context.js";
export * from "./hooks/index.js";
export { defaultVendoTheme, resolveTheme, themeCssVariables } from "./theme.js";
export { useVoice, type UseVoiceResult } from "./voice/use-voice.js";
export * from "./wire-types.js";
