"use client";

// Named re-exports, not `export *`: this file is a "use client" boundary, and
// Next's flight loader builds the client-reference manifest by statically
// enumerating a client module's named exports — it cannot do that through
// `export *`. This list must stay in exact parity with @vendoai/ui's public
// surface (packages/ui/src/index.ts); react-export-parity.test.ts fails loudly
// if a future ui export is missing here.
export {
  // client.ts
  APPROVALS_DECIDED_EVENT,
  createVendoClient,
  type ApprovalsDecidedDetail,
  type VendoClient,
  type VendoClientConfig,
  // context.ts
  VendoProvider,
  hostComponentMap,
  useVendoProvider,
  useVendoDiscoverability,
  useVendoGreeting,
  useVendoTheme,
  useVendoThemeOrDefault,
  useVendoTools,
  type ConnectorOption,
  type HostComponentsInput,
  // routes.ts
  useVendoNavigate,
  useVendoRoutes,
  // use-vendo-chat.ts
  useVendoChat,
  type UseVendoChatOptions,
  // chrome/discoverability.ts
  defaultVendoGreeting,
  type VendoDiscoverability,
  type VendoGreeting,
  // chrome/humanize.ts
  type ToolMeta,
  type ToolMetaMap,
  // chrome/embeds.tsx — the BYO-agent embeds (existing-agents)
  VendoAppEmbed,
  VendoApprovalEmbed,
  VendoToolResult,
  // chrome/vendo-slot.tsx — the mount point a host puts in its own markup, and
  // the shape of its `onParked` prop.
  VendoSlot,
  type ParkedPress,
  // hooks/*
  useActivity,
  useApp,
  useApps,
  useApprovals,
  // spec §4 (N1) — the one attention source (askCount + unseen results), and
  // the shapes it hands back.
  useAttention,
  type RunActivity,
  type RunResult,
  useAutomations,
  useConnections,
  useConnectorCatalog,
  useGrants,
  useApprovalSheetPresentation,
  useMobileTakeover,
  type MobileTakeover,
  type PollOptions,
  useSlotApp,
  // The destinations a mounted VendoSlot has reported — the "Add to…" picker's
  // only source of places to put a generated view.
  useSlots,
  type SlotEntry,
  useThreads,
  useVendoOverlay,
  type VendoOverlayController,
  useVendoStatus,
  useVendoContext,
  useVendoThread,
  type VendoThreadApproval,
  ScriptedTransport,
  type DirectorCue,
  type DirectorScript,
  // chrome/dev-mode.ts + chrome/workbench-store.ts — the dev-only workbench
  // rails: the check that decides whether such a surface renders at all, and
  // the `data-vendo-debug` feed a host's pane reads.
  developmentMode,
  publishWorkbenchPart,
  useWorkbenchFeed,
  type WorkbenchEvent,
  type WorkbenchPart,
  type WorkbenchTurn,
  // pin-events.ts — the bus a slot re-reads on, for a host that pins from its
  // own control instead of a Vendo surface.
  announcePin,
  onPinAnnounced,
  // theme.ts
  defaultVendoTheme,
  resolveTheme,
  themeCssVariables,
  // wire-types.ts
  type OpenSurface,
  type InClientVenue,
  type SeedDrift,
  type ShipDiff,
  type EditResult,
  type VersionEntry,
  type ConnectionAccount,
  type InitiatedConnection,
  type RunStatus,
  type RunRecord,
  type RunPlan,
  type AutomationEntry,
  type EnableResult,
  type Thread,
  type ThreadSummary,
  type GuardPosture,
  type VendoStatus,
} from "@vendoai/ui";
// The visible agent surface (launcher pill + panel) — re-exported from the
// chrome subpath so the init-scaffolded layout wrapper can import everything
// from "@vendoai/vendo/react": hosts only get @vendoai/vendo as a direct
// dependency, and under pnpm strict linking the transitive "@vendoai/ui/chrome"
// does not resolve for them (same TS2307 story as the registry's
// ComponentRegistry import).
export { VendoOverlay, type VendoOverlayProps } from "@vendoai/ui/chrome";
