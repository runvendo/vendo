/**
 * Public API surface for `@vendoai/runtime` — Vendo's portable agent runtime
 * (architecture Decision 1: loop, tool calling, policy, UI generation,
 * automations; depends only on the five frozen seams + @vendoai/core).
 */

// Engine
export { createVendoAgent, RENDER_VIEW_TOOL_NAME, REQUEST_CONNECT_TOOL_NAME } from "./engine.js";
export type { VendoAgentConfig, InstructionContext } from "./engine.js";

// Principal
export type { VendoPrincipal } from "./principal.js";

// Errors
export { VendoError, policyDenied, approvalRequired } from "./errors.js";
export type { VendoErrorCode, PolicyDeniedPayload, ApprovalRequiredPayload } from "./errors.js";

// Policy barrel (types, compose, annotation, natural-language, principal-rules,
// tier, grant-match, grant-policy)
export * from "./policy/index.js";

// Tool wrapping
export { wrapTool, createPausedCallTracker } from "./wrap-tool.js";
export type { WrapToolArgs, PausedCallTracker } from "./wrap-tool.js";
export { wrapClientTool } from "./wrap-client-tool.js";
export type { WrapClientToolArgs } from "./wrap-client-tool.js";

// Host-API tools (client-executed, ENG-202)
export { hostToolset, CLIENT_EXECUTOR_MARKER } from "./host-toolset.js";

// Descriptors
export { buildDescriptor } from "./descriptor.js";
export type { ToolDescriptor, ToolSource, ToolAnnotations, ToolExecutor } from "./descriptor.js";

// Toolset assembly
export { buildToolset } from "./toolset.js";
export type { ToolSourceInput } from "./toolset.js";

// Render view tool
export { createRenderViewTool } from "./render-view-tool.js";

// Shared view materialization
export { materializeView } from "./materialize-view.js";

// Brand guidance (data-driven system-prompt section from host theme tokens)
export { buildBrandGuidance } from "./brand-guidance.js";
export type { BrandGuidanceInput, HostBrandNorms } from "./brand-guidance.js";

// Generated-component compiler (JSX/TS → sandbox-ready ESM)
export { compileComponentSource } from "./compile-component.js";

// Tool-input JSON repair (engine wraps every model with this; exported for
// hosts that drive models outside the engine)
export {
  jsonRepairMiddleware,
  repairToolInputText,
  escapeControlCharsInJsonStrings,
} from "./json-repair.js";

// Request connect tool (host-privileged Connect card)
export { createRequestConnectTool } from "./request-connect-tool.js";

// Composio ingestion
export {
  ingestComposioTools,
  createComposioClient,
} from "./composio.js";
export type { ComposioClient, ComposioConfig } from "./composio.js";

// MCP ingestion (host-declared servers)
export {
  ingestMcpTools,
  createMcpToolSource,
} from "./mcp.js";
export type { McpServerConfig, McpToolSource, McpFetchResult } from "./mcp.js";

// Automations engine (ENG-188): DSL, interpreter, store, runner, scheduler,
// ingest helpers, and chat authoring tools.
export * from "./automations/index.js";

// Embedded seam implementations (in-memory/in-process) for tests and
// embedded deployments — the other half of architecture Decision 1.
// InMemoryAutomationStore and InProcessScheduler already flow from the
// automations barrel above, so only the new embedded modules are listed.
export {
  createInMemoryStore,
  InMemoryAuditLog,
  InMemoryThreadStore,
  type InMemoryStore,
} from "./embedded/in-memory-store.js";
export {
  InProcessCredentialBroker,
  type InProcessCredentialBrokerConfig,
} from "./embedded/in-process-credential-broker.js";
export { InProcessExecutor, type InProcessToolFn } from "./embedded/in-process-executor.js";
export {
  InAppChannels,
  type InAppChannelsConfig,
  type RetainedDelivery,
} from "./embedded/in-app-channels.js";

// Grant store (ENG-193 §6.1): in-memory GrantStore for the embedded seam
// slot and tests.
export { createInMemoryGrantStore } from "./grant-store.js";

// Compiled-rule store (ENG-193 §4.8/item-6): in-memory CompiledRuleStore for
// the embedded seam slot and tests.
export { createInMemoryCompiledRuleStore } from "./rule-store.js";

// FadeTracker (ENG-193 §4.4): per-principal fade eligibility, injectable
// in-memory state.
export { createFadeTracker } from "./fade-tracker.js";
export type { FadeTracker, FadeTrackerOptions, FadeEligibility } from "./fade-tracker.js";

// Grant lifecycle API (ENG-193 §4.3/§6.2): audited create/revoke, the only
// paths that mutate grants.
export { createGrantManager, scopePreview } from "./grant-manager.js";

// Rule lifecycle API (ENG-193 §4.8/item-6): audited create/revoke, the only
// paths that mutate compiled steering rules.
export { createRuleManager } from "./rule-manager.js";

// Conversational steering tools (ENG-193 §3 Moment 11/§4.8): always_ask_before
// (tighten) + stop_asking_about (loosen), built once per host like the
// automation authoring tools.
export { createSteeringTools } from "./steering-tools.js";
export type { SteeringToolsConfig } from "./steering-tools.js";

// Consent endpoint (ENG-193 §4.5): server-validated grant creation behind
// the consent channel. Transport-agnostic — hosts mount it behind their own
// route (see vendo/server and the accounting demo).
export { handleConsent, createConsentLedger } from "./consent.js";
export type { HandleConsentDeps, HandleConsentRequest, HandleConsentResult, ConsentLedger } from "./consent.js";

// Fade proposal endpoint (ENG-193 §4.4): server-re-derived accept/decline,
// keyed by proposalId (not toolCallId/thread — see fade-proposal.ts).
export { handleFadeProposal } from "./fade-proposal.js";
export type {
  HandleFadeProposalDeps,
  HandleFadeProposalResult,
} from "./fade-proposal.js";
