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
  OpenSurface,
  SandboxAdapter,
  SandboxMachine,
  VersionEntry,
} from "@vendoai/apps";
export type {
  AutomationsEngine,
  RunPlan,
  RunRecord,
  RunStatus,
} from "@vendoai/automations";
export type { VendoClient, VendoClientConfig } from "@vendoai/ui";
