/**
 * The `createVendo` config surface that `docs/quickstart.md` publishes — the
 * real thing, compiled.
 *
 * A quickstart's config listing is the one block readers paste and adapt, and
 * it rotted three ways before this file existed (keys missing, `object` where a
 * required shape belongs, types named from packages a host cannot import). A
 * name-only comparison cannot catch that: it passes while nested members, their
 * types, and their optionality all drift.
 *
 * So the doc's block lives here verbatim and the assertions at the bottom prove
 * it is EXACTLY `CreateVendoConfig`/`Vendo`, nested shapes included — any
 * mismatch is a `pnpm typecheck` failure. `quickstart.docs.test.ts` asserts
 * this region and the doc's code block stay byte-identical (modulo the two
 * import specifiers below: a package cannot resolve itself by name, so the
 * doc's host-facing `@vendoai/vendo` becomes the local entry here).
 *
 * The `.docs-check.ts` suffix is load-bearing: `tsconfig.json` excludes it from
 * the build (this is test scaffolding — it must not ship as dead declarations in
 * every tarball) and `tsconfig.docs-check.json` picks it back up for typecheck.
 *
 * Generated once from the doc; edit the doc and re-derive, never one alone.
 */
import type { CreateVendoConfig as RealCreateVendoConfig, Vendo as RealVendo } from "../server.js";

/** Invariant type identity — mutual assignability would let `object` stand in
 *  for a required shape, which is one of the drifts this file exists to catch. */
type Identical<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

// --- BEGIN docs/quickstart.md config surface ---
import type {
  ActAs, ActionsRegistry, AppsRuntime, AutomationsEngine, CatalogFile,
  ComponentCatalog, ComponentRegistry, Connector, ExtractedTool, FilesAdapter,
  Harness, HostOAuthAdapter, Json, Judge, KnowledgeAdapter, OverridesFile,
  PackProvider, PolicyConfig, PolicyFile, Principal, RunContext, RunId,
  SandboxAdapter, SecretsProvider, ToolRegistry,
  VendoAgent, VendoGuard, VendoStore, VendoTheme,
} from "../index.js";
import type {
  AgentOptions, AppsConfig, ComposedAgent, ConnectionsService, HarnessTurns,
  HostAuthPreset, ModelsConfig, PackContext, ServerActionHandler, TourEntry,
} from "../server.js";
import type { LanguageModel } from "ai";

export interface CreateVendoConfig {
  /** @deprecated superseded by `models.default`. */
  model?: LanguageModel;
  /** @deprecated the model half is superseded by `models.fill`; `disabled` stays. */
  paint?: { model?: LanguageModel; disabled?: boolean };
  models?: ModelsConfig;      // seats: default, reviewer, judge, fill, verifier
  auth?: HostAuthPreset;      // one preset fills principal + actAs + oauth
  principal?: (req: Request) => Promise<Principal | null>; // escape hatch
  tools?: ExtractedTool[];    // `vendo init`/`vendo sync` declarations, in memory
  catalog?: ComponentCatalog | ComponentRegistry;          // registry.tsx, or the array form
  theme?: VendoTheme;         // programmatic override for .vendo/theme.json
  brief?: string;             // programmatic override for .vendo/brief.md
  store?: VendoStore;
  files?: FilesAdapter;       // workspace file content; unset → blobs in the store, 5 MiB cap
  sandbox?: SandboxAdapter;
  harness?: Harness<never>;   // WHO THINKS. unset → vendo(). also: claudeCode()
  knowledge?: KnowledgeAdapter; // unset → no vendo_knowledge_search tool
  connectors?: Connector[];
  connectorApps?: string[];   // toolkit scope for the auto-composed Cloud connector
  connections?: ConnectionsService; // explicit connections adapter; always wins over defaults
  actAs?: ActAs;              // escape hatch
  serverActions?: Record<string, ServerActionHandler>; // the generated vendo-actions.ts map
  policy?: PolicyConfig;      // "cautious" | "readonly" | "autopilot" | { file } | { rules }
  judge?: Judge;
  secrets?: SecretsProvider;
  telemetry?: boolean;
  development?: boolean;    // dev-only injection seams
  profileDir?: string;        // the project root .vendo/ is read under
  fetch?: typeof fetch;       // the fetch host tool bindings execute through
  profile?: {                 // the same .vendo/ pieces, in memory (filesystem-less venues)
    tools?: ExtractedTool[];
    overrides?: OverridesFile;
    theme?: VendoTheme;
    brief?: string;
    catalog?: CatalogFile;
    policy?: PolicyFile;
    designRules?: string;
  };
  mcp?: boolean | {            // the door; `baseUrl` is its PUBLIC base URL
    baseUrl?: string;
    remoteAs?: { issuer: string; jwksUri?: string; audience: string };
    federation?: { secret: string };
  };
  oauth?: HostOAuthAdapter;   // escape hatch; required when `mcp` is true and `auth` is absent
  agent?: AgentOptions | ComposedAgent; // the chat knobs, OR a whole agent() from @vendoai/agents
  sessions?: { ttlMs?: number; sweepIntervalMs?: number; now?: () => number };
  approvals?: { parkedCallTtlMs?: number };
  apps?: {
    experimentalMachines?: boolean;
    experimentalScreenAgent?: boolean; // route vendo_make through the cheap screen agent first
    review?: {                // review-kind remixes: who may review (queue/reject/approve)
      reviewer?(ctx: RunContext): boolean | Promise<boolean>;
    };
    pipeline?: AppsConfig["pipeline"];                 // { smokeRender } — the island render gate
    fillConcurrency?: AppsConfig["fillConcurrency"];   // groups filled at once (default 2)
    checks?: AppsConfig["checks"];                     // the host's own checks, appended to the built-ins
    designRules?: string;
  };
  packs?: readonly PackProvider<PackContext>[]; // where capability comes from. unset → [apps()]
  tours?: readonly TourEntry[];
}

export interface Vendo {
  handler: (req: Request) => Promise<Response>;
  emit(event: string, payload: Json, principal: Principal): Promise<RunId[]>;
  agent: VendoAgent;
  guard: VendoGuard;
  guardedTools: ToolRegistry; // the guard-bound registry the vendo_* tool pack executes through
  apps: AppsRuntime;
  automations: AutomationsEngine;
  actions: ActionsRegistry;
  connections: ConnectionsService;
  store: VendoStore;
  harness: HarnessTurns;      // turns served through the composed Harness
}
// --- END docs/quickstart.md config surface ---

export type ConfigSurfaceMatchesTheDoc = Assert<Identical<CreateVendoConfig, RealCreateVendoConfig>>;
export type VendoSurfaceMatchesTheDoc = Assert<Identical<Vendo, RealVendo>>;
