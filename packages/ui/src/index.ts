/** @vendoai/ui — provider, hooks, client (headless, no styles). */
export {
  APPROVALS_DECIDED_EVENT,
  createVendoClient,
  type ApprovalsDecidedDetail,
  type VendoClient,
  type VendoClientConfig,
} from "./client.js";
export { VendoProvider, hostComponentMap, useVendoProvider, useVendoDiscoverability, useVendoGreeting, useVendoTheme, useVendoThemeOrDefault, useVendoTools, type ConnectorOption, type HostComponentsInput } from "./context.js";
export { useVendoNavigate, useVendoRoutes } from "./routes.js";
export { defaultVendoGreeting, type VendoDiscoverability, type VendoGreeting } from "./chrome/discoverability.js";
export type { ToolMeta, ToolMetaMap } from "./chrome/humanize.js";
export type { VendoAppEmbedProps, VendoApprovalEmbedProps, VendoApprovalEmbedState, VendoToolResultProps } from "./embeds.js";
// The components behind the frozen prop contracts, exported from the root so
// a BYO chat page needs only `@vendoai/ui`.
export { VendoAppEmbed, VendoApprovalEmbed, VendoToolResult } from "./chrome/embeds.js";
// The slot itself, from the ROOT: a host mounting one only has @vendoai/vendo
// as a direct dependency, and the "@vendoai/ui/chrome" subpath does not resolve
// under pnpm strict linking (the same TS2307 story as VendoOverlay's).
export { VendoSlot } from "./chrome/vendo-slot.js";
export type { ParkedPress } from "./tree/renderer.js";
export * from "./hooks/index.js";
// Dev-only rails: the `data-vendo-debug` feed a host's workbench pane reads,
// and the check that decides whether such a surface renders at all.
export { developmentMode } from "./chrome/dev-mode.js";
export {
  publishWorkbenchPart,
  useWorkbenchFeed,
  type WorkbenchEvent,
  type WorkbenchPart,
  type WorkbenchTurn,
} from "./chrome/workbench-store.js";
export { announcePin, onPinAnnounced } from "./pin-events.js";
export { defaultVendoTheme, resolveTheme, themeCssVariables } from "./theme.js";
export * from "./wire-types.js";
