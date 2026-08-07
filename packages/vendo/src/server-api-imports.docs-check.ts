/**
 * The import block `docs-site/reference/server-api.mdx` publishes — compiled.
 *
 * That page used to import each type from its owning block package
 * (`@vendoai/core`, `@vendoai/apps`, …), which is a TS2307 in a real host: a
 * host depends on `@vendoai/vendo`, not on the blocks, and pnpm's strict
 * linking makes that gap fatal. The page now imports from the umbrella, and
 * this file is the proof that every name it lists is actually re-exported
 * from the entry the page names.
 *
 * A package cannot resolve itself by name, so the doc's `@vendoai/vendo`
 * becomes `./index.js` here and `@vendoai/vendo/server` becomes
 * `./server.js`. Nothing else differs.
 */
import type {
  ActAs, ActionsRegistry, AppsRuntime, AutomationsEngine, ComponentCatalog,
  ComponentRegistry, Connector, ExtractedTool, FilesAdapter, Harness,
  HostOAuthAdapter, Json, KnowledgeAdapter, Principal, RunId, SandboxAdapter,
  SecretsProvider, Skill, ToolDefinition, ToolRegistry, VendoGuard, VendoStore,
  VendoTheme,
} from "./index.js";
import type {
  ComposedAgent, ConnectionsService, CreateVendoConfig, GuardRules, HarnessTurns,
  HostAuthPreset, ModelsConfig, ServerActionHandler, TourEntry,
} from "./server.js";

/** Force every imported name to be used, so an unresolved one is an error. */
export type ServerApiPageImports = [
  ActAs, ActionsRegistry, AppsRuntime, AutomationsEngine, ComponentCatalog,
  ComponentRegistry, Connector, ExtractedTool, FilesAdapter, Harness,
  HostOAuthAdapter, Json, KnowledgeAdapter, Principal, RunId, SandboxAdapter,
  SecretsProvider, Skill, ToolDefinition, ToolRegistry, VendoGuard, VendoStore,
  VendoTheme,
  ComposedAgent, ConnectionsService, CreateVendoConfig, GuardRules, HarnessTurns,
  HostAuthPreset, ModelsConfig, ServerActionHandler, TourEntry,
];
