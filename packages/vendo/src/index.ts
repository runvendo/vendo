/** @vendoai/vendo — root contract types (09-vendo §1). */
export type * from "./core/index.js";
// The app format moved off core onto its own browser-safe door; re-exported
// here so every type consumer reading it through the umbrella is untouched.
export type * from "./core/apps/index.js";
export type { VendoStore } from "./store/index.js";
export type { Thread, ThreadSummary } from "./threads.js";
// What `vendo.putUserFile` answers, and what the UI client's `files.upload`
// mirrors: where the file landed and how big it was.
export type { UploadedFile } from "./harness-turn.js";
export type {
  ActionsRegistry,
  // Task 15a — the actions-file shapes a host names when composing the
  // in-memory `createVendo({ profile })` pieces (VendoTheme already arrives
  // through `export type * from "./core/index.js"` above).
  CatalogFile,
  Connector,
  ConnectorAccount,
  ConnectorConnections,
  ExtractedTool,
  OverridesFile,
  SyncReport,
} from "./actions/index.js";
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
// What `vendo.agentTools` hands a hand-rolled loop. Structural mirrors of the
// Messages API's own shapes, so this package depends on no model SDK and the
// host annotates nothing.
export type {
  VendoAgentMessage,
  VendoAgentTool,
  VendoAgentToolResult,
  VendoAgentTools,
} from "./agent-tools.js";
export type {
  Judge,
  PolicyConfig,
  PolicyFile,
  PolicyFn,
  PolicyRule,
  VendoGuard,
} from "./guard/index.js";
export type {
  AppsRuntime,
  EditResult,
  OpenSurface,
  SeedDrift,
  SandboxAdapter,
  SandboxMachine,
  VersionEntry,
} from "./apps/index.js";
export type {
  AutomationsEngine,
  RunPlan,
  RunRecord,
  RunStatus,
} from "./automations/index.js";
export type { VendoClient, VendoClientConfig } from "./ui/index.js";
// 10-mcp §3: the one type a host implements to open the MCP door
// (`createVendo({ mcp: true, oauth })`). The rest of the door's surface
// (createMcpDoor, McpDoor, McpDoorConfig, McpRunContext) is
// umbrella-internal — the Vendo interface exposes no `mcp` handle (09 §2) — so
// only this host-facing seam belongs on the root.
export type { HostOAuthAdapter } from "./mcp/index.js";
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
export { defineTool } from "./core/index.js";
// The copy-paste install prompt, so a surface that offers it (docs, README,
// console) builds the one text instead of keeping a copy that rots.
export { buildAgentPrompt } from "./agent-prompt.js";
// The standalone-agent surface — `agent()`, `tool()`, `serve()`, `agentHandler`,
// `createUser`, `createTurns`, `awayRunner`, `e2b`, `postgres`,
// `provideCloudAdapters` and the rest. It shipped as `@vendoai/agents`' barrel
// until that package folded in here; the package name retired, the API did not,
// so the whole barrel is re-exported verbatim under its new home.
export * from "./turn/index.js";
// `Turn` and `TurnResult` are claimed by both halves and are NOT the same
// types: core's `Turn` is the Build-contract turn a HARNESS is handed, the
// agent surface's is the in-flight handle a CALLER holds. The root keeps
// core's — what it meant before the fold-in — so no existing umbrella consumer
// silently changes meaning. A host migrating off `@vendoai/agents` that names
// either one gets a compile error at its use site, never a quiet swap.
export type { Turn, TurnResult } from "./core/index.js";
