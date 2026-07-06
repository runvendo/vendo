/**
 * Root of the public `vendo` package.
 *
 * This entry is types-only by design: it exists so `import type { ... } from
 * "vendo"` works without pulling in either the Node-only server runtime or
 * the browser-only React runtime. Runtime code lives in ./server (Node) and
 * ./react (browser) — importing it here would let one side's code leak into
 * the other side's bundle (e.g. a Node-only dependency ending up in a
 * client bundle, or vice versa).
 *
 * Every export below is `export type`, never `export *`, so a runtime value
 * added to `@vendoai/core` later can't silently leak into this file.
 */

export type {
  // schema.ts
  VendoSchema,
  // tool.ts
  Tool,
  ToolSet,
  // host-api.ts
  HostToolAnnotations,
  HostToolParam,
  HostHttpCall,
  HostToolDefinition,
  OpenApiSpec,
  HostToolCallResult,
  ExecuteHostToolCallOptions,
  // ui.ts
  UINodeSource,
  ComponentNode,
  GeneratedNode,
  UINode,
  // protocol.ts
  VendoMetadata,
  AnchorContextBlock,
  ResolvedRemixSource,
  VerifiedPinBase,
  AnchorRef,
  RemixSourceRecord,
  RemixSourceResolver,
  EnvManifest,
  EnvImportStatus,
  ActionRequest,
  ActionResult,
  DispatchAction,
  ConsentTierPart,
  VendoDataParts,
  VendoUIMessage,
  // consent.ts
  ConsentRequest,
  ParkedActionResolution,
  ConsentGrantDraft,
  ConsentResponse,
  // fade.ts
  FadeShape,
  FadeProposalResolution,
  // agent.ts
  RunInput,
  VendoAgent,
  // registry.ts
  RegisteredComponent,
  ComponentRegistry,
  // genui/format.ts
  PropBinding,
  PropValue,
  DataQuery,
  GenNode,
  GeneratedPayload,
  GenUIErrorCode,
  GenUIValidation,
  // genui/host-props.ts
  HostPropIssue,
  // manifest/theme.ts
  ManifestTheme,
  // manifest/tool.ts
  JsonSchemaDocument,
  ManifestToolAnnotations,
  ManifestToolBinding,
  ManifestTool,
  // manifest/event.ts
  HostEventDeclaration,
  // manifest/component.ts
  ManifestComponent,
  // manifest/manifest.ts
  ToolsManifest,
  VendoManifest,
  ManifestRef,
  // seams/principal.ts
  Principal,
  // seams/store.ts
  Store,
  ThreadRecord,
  ThreadStore,
  SavedVendo,
  SavedVendoStore,
  AutomationRecord,
  AutomationRun,
  AutomationStore,
  RemixRecord,
  RemixStore,
  AuditEvent,
  AuditLog,
  // seams/grants.ts
  GrantConstraint,
  GrantScope,
  GrantDuration,
  GrantSource,
  PermissionGrant,
  GrantStore,
  // seams/compiled-rules.ts
  CompiledRule,
  CompiledRuleStore,
  // seams/credential-broker.ts
  CredentialBroker,
  GrantRequest,
  BrokeredGrant,
  // seams/executor.ts
  Executor,
  ToolCallRequest,
  ExecutionContext,
  ToolCallOutcome,
  // seams/scheduler.ts
  Scheduler,
  TimeTrigger,
  AutomationFiring,
  // seams/channels.ts
  Channels,
  ChannelKind,
  OutboundMessage,
  AutomationDelivery,
  // prompt/index.ts
  PromptModality,
  ChatInstructionsInput,
  VoiceInstructionsInput,
  ToolSummaryInput,
  CapBudget,
  CappedResult,
} from "@vendoai/core";

export type { BrandTokens } from "@vendoai/components/theme";
