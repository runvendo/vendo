import { z } from "zod";
import {
  VENDO_CAPABILITIES_FORMAT,
  VENDO_OVERRIDES_FORMAT,
  VENDO_TOOLS_FORMAT,
  jsonSchemaSchema,
  riskLabelSchema,
  stepSchema,
  toolDescriptorSchema,
  type JsonSchema,
  type Step,
  type ToolDescriptor,
} from "@vendoai/core";

export const VENDO_CATALOG_FORMAT = "vendo/catalog@1" as const;
export const VENDO_CATALOG_PROPOSALS_FORMAT = "vendo/catalog-proposals@1" as const;

/** A deterministic or explicitly registered host-component catalog entry. */
export interface CatalogEntry {
  name: string;
  /** Root-relative module plus export/property path, for example `./src/card.tsx#Card`. */
  exportPath: string;
  /** JSON Schema 2020-12 compatible shape, using the ToolDescriptor.inputSchema convention. */
  propsSchema: JsonSchema;
  /** Human-reviewed when-to-use guidance. Scanners never author this field. */
  description: string;
  /** Human-reviewed JSX snippets. Scanners never author this field. */
  examples?: string[];
  source: "registered" | "scanned";
  disabled?: boolean;
  note?: string;
}

/** Strict because hand edits must fail loudly rather than disappear on parse. */
export const catalogEntrySchema = z.object({
  name: z.string().regex(/^[A-Z][A-Za-z0-9_$]*$/),
  exportPath: z.string().min(1),
  propsSchema: jsonSchemaSchema,
  description: z.string(),
  examples: z.array(z.string().min(1)).optional(),
  source: z.enum(["registered", "scanned"]),
  disabled: z.boolean().optional(),
  note: z.string().min(1).optional(),
}).strict() satisfies z.ZodType<CatalogEntry>;

export interface CatalogFile {
  format: typeof VENDO_CATALOG_FORMAT;
  entries: CatalogEntry[];
}

export const catalogFileSchema = z.object({
  format: z.literal(VENDO_CATALOG_FORMAT),
  entries: z.array(catalogEntrySchema),
}).strict().superRefine((catalog, context) => {
  const names = new Set<string>();
  for (const [index, entry] of catalog.entries.entries()) {
    if (names.has(entry.name)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate component name ${entry.name}`, path: ["entries", index, "name"] });
    }
    names.add(entry.name);
  }
}) satisfies z.ZodType<CatalogFile>;

export interface CatalogCopyFields {
  description: string;
  examples?: string[];
}

export const catalogCopyFieldsSchema = z.object({
  description: z.string(),
  examples: z.array(z.string().min(1)).optional(),
}).strict() satisfies z.ZodType<CatalogCopyFields>;

const proposedCatalogCopyFieldsSchema = catalogCopyFieldsSchema.extend({
  description: z.string().min(1),
}).strict();

export interface CatalogCopyProposal {
  name: string;
  /** Deterministic scanner context the proposal was authored against. */
  basis: {
    exportPath: string;
    propsSchema: JsonSchema;
    note?: string;
  };
  before: CatalogCopyFields;
  after: CatalogCopyFields;
}

const catalogCopyProposalBasisSchema = z.object({
  exportPath: z.string().min(1),
  propsSchema: jsonSchemaSchema,
  note: z.string().min(1).optional(),
}).strict();

export const catalogCopyProposalSchema = z.object({
  name: z.string().regex(/^[A-Z][A-Za-z0-9_$]*$/),
  basis: catalogCopyProposalBasisSchema,
  before: catalogCopyFieldsSchema,
  after: proposedCatalogCopyFieldsSchema,
}).strict() satisfies z.ZodType<CatalogCopyProposal>;

/** Review-only copy proposals. Runtime never reads this artifact. */
export interface CatalogProposalsFile {
  format: typeof VENDO_CATALOG_PROPOSALS_FORMAT;
  catalogFormat: typeof VENDO_CATALOG_FORMAT;
  proposals: CatalogCopyProposal[];
}

export const catalogProposalsFileSchema = z.object({
  format: z.literal(VENDO_CATALOG_PROPOSALS_FORMAT),
  catalogFormat: z.literal(VENDO_CATALOG_FORMAT),
  proposals: z.array(catalogCopyProposalSchema),
}).strict() satisfies z.ZodType<CatalogProposalsFile>;

/** 04-actions §1: the http methods a binding can carry. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const httpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]) satisfies z.ZodType<HttpMethod>;

/** 04-actions §1: execution binding for a scanned host route. */
export interface RouteBinding {
  kind: "route";
  method: HttpMethod;
  path: string;                    // "/api/invoices/{id}" — {param} segments substituted from args
  argsIn: "query" | "body";        // where non-path args travel
}

export const routeBindingSchema = z.object({
  kind: z.literal("route"),
  method: httpMethodSchema,
  path: z.string().startsWith("/"),
  argsIn: z.enum(["query", "body"]),
}).passthrough() satisfies z.ZodType<RouteBinding>;

/**
 * 04-actions §1: execution binding for an OpenAPI operation.
 * `method` + `path` are carried alongside the contract's `operationId`/`baseUrl`
 * so the runtime can execute without re-reading the spec (additive fields;
 * consumers ignore unknown keys per 01-core §15).
 */
export interface OpenApiBinding {
  kind: "openapi";
  operationId: string;
  baseUrl?: string;                // absent → same-origin (createActions baseUrl)
  method: HttpMethod;
  path: string;
}

export const openApiBindingSchema = z.object({
  kind: z.literal("openapi"),
  operationId: z.string().min(1),
  baseUrl: z.string().optional(),
  method: httpMethodSchema,
  path: z.string().startsWith("/"),
}).passthrough() satisfies z.ZodType<OpenApiBinding>;

/**
 * 04-actions §1 (additive within vendo/tools@1): execution binding for a tRPC
 * procedure. Tool identity is mount + `procedure` dot-path, not a method+path
 * pair. Execution is the tRPC HTTP envelope against the host mount: queries
 * are GET `{mount}/{procedure}?input=...`, mutations POST `{mount}/{procedure}`.
 * `transformer: "superjson"` marks mounts whose tRPC root applies the superjson
 * data transformer, so the runtime wraps/unwraps the `{ json: ... }` envelope.
 */
export interface TrpcBinding {
  kind: "trpc";
  procedure: string;               // dot-path, e.g. "polls.list"
  type: "query" | "mutation";
  mount: string;                   // "/api/trpc" — resolved against createActions baseUrl
  transformer?: "superjson";
}

export const trpcBindingSchema = z.object({
  kind: z.literal("trpc"),
  procedure: z.string().min(1),
  type: z.enum(["query", "mutation"]),
  mount: z.string().startsWith("/"),
  transformer: z.literal("superjson").optional(),
}).passthrough() satisfies z.ZodType<TrpcBinding>;

/**
 * 04-actions §1 (additive within vendo/tools@1): execution binding for a
 * GraphQL operation. Tool identity is endpoint + `operation` (the schema field
 * name on the query/mutation root), not a method+path pair. Execution is a
 * POST of `{ query: document, variables: args }` to the host endpoint; every
 * tool argument rides as a same-named GraphQL variable. `document` carries the
 * full statically-generated operation (variable declarations derived from the
 * schema's argument types plus a depth-limited default selection set); it is
 * absent only on disabled tools whose operation could not be made statically
 * executable (fail-closed, 04 §1).
 */
export interface GraphqlBinding {
  kind: "graphql";
  operation: string;               // schema field name, e.g. "createInvoice"
  type: "query" | "mutation";
  endpoint: string;                // "/graphql" — resolved against createActions baseUrl
  document?: string;
}

export const graphqlBindingSchema = z.object({
  kind: z.literal("graphql"),
  operation: z.string().min(1),
  type: z.enum(["query", "mutation"]),
  endpoint: z.string().startsWith("/"),
  document: z.string().min(1).optional(),
}).passthrough() satisfies z.ZodType<GraphqlBinding>;

/**
 * 04-actions §1 (additive within vendo/tools@1): execution binding for a Next.js
 * server action. Tool identity is `module` (root-relative posix path) plus
 * `exportName` — never a method+path pair. Execution is direct in-process
 * dispatch through the registration map the generated wiring file passes into
 * `createVendo({ serverActions })`; `params` carries the action's ordered
 * parameter names so the args object maps onto positional arguments. When the
 * registration map lacks the action, execution fails closed (clear error, no
 * work performed). There are NO Next action-id bindings.
 */
export interface ServerActionBinding {
  kind: "server-action";
  module: string;                  // "app/actions/invoices.ts" — root-relative posix path
  exportName: string;              // "createInvoice" | "default"
  params: string[];                // ordered parameter names; args object keys map onto these
}

export const serverActionBindingSchema = z.object({
  kind: z.literal("server-action"),
  module: z.string().min(1),
  exportName: z.string().min(1),
  params: z.array(z.string().min(1)),
}).passthrough() satisfies z.ZodType<ServerActionBinding>;

/**
 * 04-actions §6: ordered steps over primitive host/connector tools, reusing the
 * core §11 `Step` shape. Expressions see `{ args, steps, item }`. Compounds are
 * agent-authored: they live in `.vendo/capabilities.json`, never `tools.json`.
 */
export interface CompoundBinding {
  kind: "compound";
  steps: Step[];
}

export const compoundBindingSchema = z.object({
  kind: z.literal("compound"),
  steps: z.array(stepSchema).min(1).max(50),
}).passthrough().refine(
  (binding) => new Set(binding.steps.map((step) => step.id)).size === binding.steps.length,
  { message: "compound step ids must be unique" },
) satisfies z.ZodType<CompoundBinding>;

/** The bindings deterministic extraction may emit into `.vendo/tools.json`. */
export type PrimitiveToolBinding = RouteBinding | OpenApiBinding | TrpcBinding | GraphqlBinding | ServerActionBinding;

export type ToolBinding = RouteBinding | OpenApiBinding | TrpcBinding | GraphqlBinding | ServerActionBinding | CompoundBinding;

export const toolBindingSchema = z.union([
  routeBindingSchema,
  openApiBindingSchema,
  trpcBindingSchema,
  graphqlBindingSchema,
  serverActionBindingSchema,
  compoundBindingSchema,
]) satisfies z.ZodType<ToolBinding>;

/**
 * tools.json stays deterministic (04 §1/§6). The compound base shape is a
 * discriminator branch so route/openapi keep their precise per-branch errors;
 * the tool-level refine below then rejects it with one clear pointer home.
 */
const compoundKindSchema = z.object({ kind: z.literal("compound") }).passthrough();

const extractedBindingSchema = z.discriminatedUnion("kind", [
  routeBindingSchema,
  openApiBindingSchema,
  trpcBindingSchema,
  graphqlBindingSchema,
  serverActionBindingSchema,
  compoundKindSchema,
]) as unknown as z.ZodType<PrimitiveToolBinding>;

/** 04-actions §2: a descriptor plus its execution binding — one entry of `.vendo/tools.json`. */
export type ExtractedTool = ToolDescriptor & {
  binding: PrimitiveToolBinding;
  /** Fail-closed extraction (04 §1): a route the scanner can't classify is emitted disabled, never silently auto-allowed. */
  disabled?: boolean;
  note?: string;
};

export const extractedToolSchema = toolDescriptorSchema.extend({
  binding: extractedBindingSchema,
  disabled: z.boolean().optional(),
  note: z.string().optional(),
}).superRefine((tool, context) => {
  if ((tool.binding as { kind?: string }).kind === "compound") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["binding"],
      message: "compound bindings live in .vendo/capabilities.json — .vendo/tools.json stays deterministic (04-actions §6)",
    });
  }
}) satisfies z.ZodType<ExtractedTool>;

/** `.vendo/tools.json` — generated, host-committed (04 §1). */
export interface ToolsFile {
  format: typeof VENDO_TOOLS_FORMAT;
  tools: ExtractedTool[];
}

export const toolsFileSchema = z.object({
  format: z.literal(VENDO_TOOLS_FORMAT),
  tools: z.array(extractedToolSchema),
}).passthrough() satisfies z.ZodType<ToolsFile>;

/**
 * `.vendo/overrides.json` — human-written, respected forever (04 §1).
 * Strict on purpose: a typo in a hand-written override must fail loudly,
 * never be silently ignored.
 */
export interface ToolOverride {
  risk?: ToolDescriptor["risk"];
  critical?: boolean;
  disabled?: boolean;
  description?: string;
}

export const toolOverrideSchema = z.object({
  risk: riskLabelSchema.optional(),
  critical: z.boolean().optional(),
  disabled: z.boolean().optional(),
  description: z.string().optional(),
}).strict() satisfies z.ZodType<ToolOverride>;

export interface OverridesFile {
  format: typeof VENDO_OVERRIDES_FORMAT;
  tools: Record<string, ToolOverride>;
  remix?: { ignoreSlots: string[] };
}

export const overridesFileSchema = z.object({
  format: z.literal(VENDO_OVERRIDES_FORMAT),
  tools: z.record(toolOverrideSchema),
  remix: z.object({
    ignoreSlots: z.array(z.string().min(1)),
  }).strict().optional(),
}).strict() satisfies z.ZodType<OverridesFile>;

/**
 * 04-actions §1: a capability brief — reviewed prose the agent layer may attach
 * to primitive tools. Carried and validated today; consumed by later milestones.
 */
export interface CapabilityBrief {
  name: string;
  text: string;
  tools?: string[];
}

export const capabilityBriefSchema = z.object({
  name: z.string().min(1),
  text: z.string().min(1),
  tools: z.array(z.string().min(1)).optional(),
}).passthrough() satisfies z.ZodType<CapabilityBrief>;

/** 04-actions §6: one agent-authored compound tool of `.vendo/capabilities.json`. */
export type CompoundTool = ToolDescriptor & {
  binding: CompoundBinding;
  disabled?: boolean;
  note?: string;
};

export const compoundToolSchema = toolDescriptorSchema.extend({
  binding: compoundBindingSchema,
  disabled: z.boolean().optional(),
  note: z.string().optional(),
}) satisfies z.ZodType<CompoundTool>;

/**
 * `.vendo/capabilities.json` — agent-authored (refine engine), human-reviewed
 * diffs, host-committed (04 §1/§6). Passthrough like `tools.json`: a generated
 * artifact evolves additively, unknown keys must survive.
 */
export interface CapabilitiesFile {
  format: typeof VENDO_CAPABILITIES_FORMAT;
  tools: CompoundTool[];
  briefs?: CapabilityBrief[];
}

export const capabilitiesFileSchema = z.object({
  format: z.literal(VENDO_CAPABILITIES_FORMAT),
  tools: z.array(compoundToolSchema),
  briefs: z.array(capabilityBriefSchema).optional(),
}).passthrough() satisfies z.ZodType<CapabilitiesFile>;

/**
 * Remixable component baseline captured by sync (06 §8, written to
 * `.vendo/remixable/<slot>.json`). Structural copy of apps' `PinBaseline` —
 * actions depends on core only, and this is a JSON format, not an import.
 */
export interface CapturedPinBaseline {
  slot: string;
  source: string;
  hash: string;                    // "sha256:..." of source
  exportable: boolean;
  capturedAt: string;              // IsoDateTime
  /** Import specifier -> captured module id for imports in the primary source. */
  sourceImports?: Record<string, string>;
  /** Source-owned modules reachable within two local-import hops. */
  subSources?: Record<string, CapturedPinSubSource>;
  /** Static JSON-compatible props declared by the remixable registration. */
  sampleProps?: Record<string, unknown>;
  /** Direct CSS imports from canonical app root files, in deterministic order. */
  styles?: CapturedPinStyle[];
}

/** Machine-readable reason a remixable registration needs runtime capture. */
export type UnresolvedPinReason =
  | "inline-component"
  | "component-not-imported"
  | "import-not-found"
  | "unsafe-source"
  | "unsafe-slot";

export interface UnresolvedPin {
  slot: string;
  component: string;
  reason: UnresolvedPinReason;
  hint: string;
}

export interface CapturedPinSubSource {
  source: string;
  imports: Record<string, string>;
}

export interface CapturedPinStyle {
  path: string;
  css: string;
}

const capturedPinSubSourceSchema = z.object({
  source: z.string(),
  imports: z.record(z.string()),
}).passthrough() satisfies z.ZodType<CapturedPinSubSource>;

const capturedPinStyleSchema = z.object({
  path: z.string(),
  css: z.string(),
}).passthrough() satisfies z.ZodType<CapturedPinStyle>;

export const capturedPinBaselineSchema = z.object({
  slot: z.string().min(1),
  source: z.string(),
  hash: z.string().startsWith("sha256:"),
  exportable: z.boolean(),
  capturedAt: z.string(),
  sourceImports: z.record(z.string()).optional(),
  subSources: z.record(capturedPinSubSourceSchema).optional(),
  sampleProps: z.record(z.unknown()).optional(),
  styles: z.array(capturedPinStyleSchema).optional(),
}).passthrough() satisfies z.ZodType<CapturedPinBaseline>;

/** 04-actions §1 */
export interface BreakingChange {
  tool: string;
  change: "removed" | "input-narrowed" | "renamed";
}

export const breakingChangeSchema = z.object({
  tool: z.string(),
  change: z.enum(["removed", "input-narrowed", "renamed"]),
}).passthrough() satisfies z.ZodType<BreakingChange>;

/** 04-actions §1 */
export interface SyncReport {
  tools: { added: string[]; removed: string[]; changed: string[] };
  breaking: BreakingChange[];
  pins: { captured: string[]; drifted: string[] };
  catalog: { discovered: number; registered: number };
}
