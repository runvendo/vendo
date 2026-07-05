/**
 * Public API surface for `@vendoai/runtime` — Vendo's portable agent runtime
 * (architecture Decision 1: loop, tool calling, policy, UI generation,
 * automations; depends only on the five frozen seams + @vendoai/core).
 */

export const VENDO_RUNTIME_PACKAGE = "@vendoai/runtime";

// Engine
export { createVendoAgent, RENDER_VIEW_TOOL_NAME, REQUEST_CONNECT_TOOL_NAME } from "./engine";
export type { VendoAgentConfig, InstructionContext } from "./engine";

// Principal
export type { VendoPrincipal } from "./principal";

// Errors
export { VendoError, policyDenied, approvalRequired } from "./errors";
export type { VendoErrorCode, PolicyDeniedPayload, ApprovalRequiredPayload } from "./errors";

// Policy barrel (types, compose, annotation, natural-language, principal-rules,
// tier, grant-match, grant-policy)
export * from "./policy";

// Tool wrapping
export { wrapTool, createPausedCallTracker } from "./wrap-tool";
export type { WrapToolArgs, PausedCallTracker } from "./wrap-tool";
export { wrapClientTool } from "./wrap-client-tool";
export type { WrapClientToolArgs } from "./wrap-client-tool";

// Host-API tools (client-executed, ENG-202)
export { hostToolset, CLIENT_EXECUTOR_MARKER } from "./host-toolset";

// Descriptors
export { buildDescriptor } from "./descriptor";
export type { ToolDescriptor, ToolSource, ToolAnnotations, ToolExecutor } from "./descriptor";

// Toolset assembly
export { buildToolset } from "./toolset";
export type { ToolSourceInput } from "./toolset";

// Render view tool
export { createRenderViewTool } from "./render-view-tool";

// Edit view tool (remix fast-edits delta path) + shared materialization
export { createEditViewTool, EDIT_VIEW_TOOL_NAME } from "./edit-view-tool";
export type { EditViewToolOptions } from "./edit-view-tool";
export { materializeView } from "./materialize-view";
export { hashSources } from "./remix/envelope";

// Brand guidance (data-driven system-prompt section from host theme tokens)
export { buildBrandGuidance } from "./brand-guidance";
export type { BrandGuidanceInput, HostBrandNorms } from "./brand-guidance";

// Generated-component compiler (JSX/TS → sandbox-ready ESM)
export { compileComponentSource } from "./compile-component";

// Tool-input JSON repair (engine wraps every model with this; exported for
// hosts that drive models outside the engine)
export {
  jsonRepairMiddleware,
  repairToolInputText,
  escapeControlCharsInJsonStrings,
} from "./json-repair";

// Remix fast-edits primitives (baseline/hunks/envelope)
export { normalizeBaseline, numberedLines, NORMALIZER_VERSION } from "./remix/baseline";
export type { NormalizedBaseline } from "./remix/baseline";
export { applyHunks, validateHunkLines } from "./remix/hunks";
export type { Hunk, HunkError, HunkResult } from "./remix/hunks";
export { createRemixSealer, deriveSealKey } from "./remix/envelope";
export type { RemixSealer, SealKey, SealKeySources, MintInput, VerifyContext } from "./remix/envelope";

// Request connect tool (host-privileged Connect card)
export { createRequestConnectTool } from "./request-connect-tool";

// Composio ingestion
export {
  ingestComposioTools,
  createComposioClient,
} from "./composio";
export type { ComposioClient, ComposioConfig } from "./composio";

// MCP ingestion (host-declared servers)
export {
  ingestMcpTools,
  createMcpToolSource,
} from "./mcp";
export type { McpServerConfig, McpToolSource, McpFetchResult } from "./mcp";

// Automations engine (ENG-188): DSL, interpreter, store, runner, scheduler,
// ingest helpers, and chat authoring tools.
export * from "./automations";

// Embedded seam implementations (in-memory/in-process) for tests and
// embedded deployments — the other half of architecture Decision 1.
// InMemoryAutomationStore and InProcessScheduler already flow from the
// automations barrel above, so only the new embedded modules are listed.
export {
  createInMemoryStore,
  InMemoryAuditLog,
  InMemoryRemixStore,
  InMemorySavedVendoStore,
  InMemoryThreadStore,
  type InMemoryStore,
} from "./embedded/in-memory-store";
export {
  InProcessCredentialBroker,
  type InProcessCredentialBrokerConfig,
} from "./embedded/in-process-credential-broker";
export { InProcessExecutor, type InProcessToolFn } from "./embedded/in-process-executor";
export {
  InAppChannels,
  type InAppChannelsConfig,
  type RetainedDelivery,
} from "./embedded/in-app-channels";

// Grant store (ENG-193 §6.1): in-memory GrantStore for the embedded seam
// slot and tests.
export { createInMemoryGrantStore } from "./grant-store";

// Compiled-rule store (ENG-193 §4.8/item-6): in-memory CompiledRuleStore for
// the embedded seam slot and tests.
export { createInMemoryCompiledRuleStore } from "./rule-store";

// FadeTracker (ENG-193 §4.4): per-principal fade eligibility, injectable
// in-memory state.
export { createFadeTracker } from "./fade-tracker";
export type { FadeTracker, FadeTrackerOptions, FadeEligibility } from "./fade-tracker";

// Grant lifecycle API (ENG-193 §4.3/§6.2): audited create/revoke, the only
// paths that mutate grants.
export { createGrantManager, scopePreview } from "./grant-manager";

// Rule lifecycle API (ENG-193 §4.8/item-6): audited create/revoke, the only
// paths that mutate compiled steering rules.
export { createRuleManager } from "./rule-manager";

// Conversational steering tools (ENG-193 §3 Moment 11/§4.8): always_ask_before
// (tighten) + stop_asking_about (loosen), built once per host like the
// automation authoring tools.
export { createSteeringTools } from "./steering-tools";
export type { SteeringToolsConfig } from "./steering-tools";

// Consent endpoint (ENG-193 §4.5): server-validated grant creation behind
// the consent channel. Transport-agnostic — hosts mount it behind their own
// route (see @vendoai/next and the accounting demo).
export { handleConsent, createConsentLedger } from "./consent";
export type { HandleConsentDeps, HandleConsentRequest, HandleConsentResult, ConsentLedger } from "./consent";

// Fade proposal endpoint (ENG-193 §4.4): server-re-derived accept/decline,
// keyed by proposalId (not toolCallId/thread — see fade-proposal.ts).
export { handleFadeProposal } from "./fade-proposal";
export type {
  HandleFadeProposalDeps,
  HandleFadeProposalResult,
} from "./fade-proposal";
