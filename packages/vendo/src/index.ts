/** @vendoai/vendo — root contract types (09-vendo §1). */
export type * from "@vendoai/core";
export type { VendoStore } from "@vendoai/store";
export type { Thread, ThreadSummary, VendoAgent } from "@vendoai/agent";
export type {
  ActionsRegistry,
  Connector,
  ExtractedTool,
  SyncReport,
} from "@vendoai/actions";
export type {
  Judge,
  PolicyConfig,
  PolicyFile,
  PolicyFn,
  PolicyRule,
  Scanner,
  VendoGuard,
} from "@vendoai/guard";
export type {
  AppsRuntime,
  EditResult,
  InClientApproval,
  InClientVerdict,
  OpenSurface,
  PinDrift,
  PinRebaseResult,
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
// (createMcpDoor, McpDoor, AppsPort, McpDoorConfig, McpRunContext) is
// umbrella-internal — the Vendo interface exposes no `mcp` handle (09 §2) — so
// only this host-facing seam belongs on the root.
export type { HostOAuthAdapter } from "@vendoai/mcp";
export { remixable, type RemixableRegistration, type RemixableReportOptions } from "./remixable.js";
