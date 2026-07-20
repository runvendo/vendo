/** @vendoai/ui — provider, hooks, client (headless, no styles). docs/archive/contracts/08-ui.md */
export { createVendoClient, type VendoClient, type VendoClientConfig } from "./client.js";
export { VendoProvider, hostComponentMap, useVendoContext, useVendoDiscoverability, useVendoGreeting, useVendoTheme, useVendoTools, type ConnectorOption, type HostComponentsInput } from "./context.js";
export { defaultVendoGreeting, type VendoDiscoverability, type VendoGreeting } from "./chrome/discoverability.js";
export type { ToolMeta, ToolMetaMap } from "./chrome/humanize.js";
export type { VendoAppEmbedProps, VendoApprovalEmbedProps, VendoApprovalEmbedState, VendoToolResultProps } from "./embeds.js";
// Existing-agents Lane B — the components behind the frozen prop contracts,
// exported from the root so a BYO chat page needs only `@vendoai/ui`.
export { VendoAppEmbed, VendoApprovalEmbed, VendoToolResult } from "./chrome/embeds.js";
export * from "./hooks/index.js";
export { defaultVendoTheme, resolveTheme, themeCssVariables } from "./theme.js";
export { useVoice, type UseVoiceResult } from "./voice/use-voice.js";
export * from "./wire-types.js";
