/** @vendoai/vendo — root contract types (09-vendo §1). */
export type * from "@vendoai/core";
// The app format moved off core onto its own browser-safe door; re-exported
// here so every type consumer reading it through the umbrella is untouched.
export type * from "@vendoai/apps/contract";
export type { VendoStore } from "@vendoai/store";
export type { Thread, ThreadSummary } from "./threads.js";
// What `vendo.putUserFile` answers, and what the ui client's `files.upload`
// mirrors: where the file landed and how big it was.
export type { UploadedFile } from "./harness-turn.js";
export type {
  ActionsRegistry,
  // Task 15a — the actions-file shapes a host names when composing the
  // in-memory `createVendo({ profile })` pieces (VendoTheme already arrives
  // through `export type * from "@vendoai/core"` above).
  CatalogFile,
  Connector,
  ConnectorAccount,
  ConnectorConnections,
  ExtractedTool,
  OverridesFile,
  SyncReport,
} from "@vendoai/actions";
export type { ConnectionsService, InitiatedConnection, InitiateOptions } from "./connections.js";
export type {
  TenantConnectorInput,
  TenantConnectorResult,
  TenantConnectorSummary,
  TenantConnectors,
} from "./tenant-connectors.js";
export type {
  ChannelsService,
  InboundEvent,
  InboundLinkEvent,
  InboundTextEvent,
  TextChannelRegistration,
} from "./channels.js";
export type { TextChannelApi, VendoChannels } from "./types.js";
export type {
  Judge,
  PolicyConfig,
  PolicyFile,
  PolicyFn,
  PolicyRule,
  VendoGuard,
} from "@vendoai/guard";
export type {
  AppsRuntime,
  EditResult,
  InClientApproval,
  InClientVerdict,
  OpenSurface,
  SeedDrift,
  SandboxAdapter,
  SandboxMachine,
  ShipDiff,
  VersionEntry,
} from "@vendoai/apps";
export type {
  AutomationsEngine,
  RunPlan,
  RunRecord,
  RunStatus,
} from "@vendoai/automations";
export type { VendoClient, VendoClientConfig } from "@vendoai/ui";
// 10-mcp §3: the one type a host implements to open the MCP door
// (`createVendo({ mcp: true, oauth })`). The rest of @vendoai/mcp's surface
// (createMcpDoor, McpDoor, McpDoorConfig, McpRunContext) is
// umbrella-internal — the Vendo interface exposes no `mcp` handle (09 §2) — so
// only this host-facing seam belongs on the root.
export type { HostOAuthAdapter } from "@vendoai/mcp";
// Existing-agents Lane B — the wire's per-approval resolution for a parked BYO
// guarded call (what GET /approvals/:id answers; the ui client mirrors it).
export type { ByoApprovalResolution } from "./byo-approvals.js";
// The three Vendo-owned tool registries, on the root because a host composing
// its OWN actions registry (rather than `createVendo`'s) has to be able to add
// them. They stood on `@vendoai/agent`'s public barrel until the engine fold
// moved them here; this keeps that surface reachable under its new name.
export { ASK_USER_TOOL, askUserRegistry } from "./ask-user.js";
export {
  VENDO_VERB_TOOLS,
  vendoVerbsRegistry,
  type VendoVerbFinding,
  type VendoVerbPorts,
} from "./vendo-verbs.js";
export {
  CONNECTOR_DISCOVERY_TOOLS,
  USE_SERVICE_TOOL,
  connectorDiscoveryRegistry,
  type ConnectorDiscoveryPorts,
  type ServiceToolMatch,
} from "./connector-discovery.js";
// Writing a tool by hand for the `tools:` slot — beside the registries above
// for the same reason: it is a VALUE a host composing capability needs.
export { defineTool } from "@vendoai/core";
