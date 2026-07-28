import { z } from "zod";
import {
  fieldSemanticSchema,
  jsonSchemaSchema,
  riskLabelSchema,
  stepSchema,
  toolDescriptorSchema,
  type FieldSemantic,
  type JsonSchema,
  type Step,
  type ToolDescriptor,
} from "@vendoai/core";

export const VENDO_CATALOG_FORMAT = "vendo/catalog@1" as const;

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
 * 04-actions §1 (additive within vendo/tools@3): execution binding for a tRPC
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
 * 04-actions §1 (additive within vendo/tools@3): execution binding for a
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
 * 04-actions §1 (additive within vendo/tools@3): execution binding for a Next.js
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
 * agent-authored: they live in `.vendo/overrides.json` compounds, never `tools.json`.
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

/**
 * `.vendo/` is TWO files split by AUTHOR: `tools.json` (vendo/tools@3) is the
 * machine layer `vendo sync` regenerates wholesale, `overrides.json`
 * (vendo/overrides@3) is the only human-edited file.
 */
export const VENDO_TOOLS_FORMAT = "vendo/tools@3" as const;

export const VENDO_OVERRIDES_FORMAT = "vendo/overrides@3" as const;

/** 04-actions §2: a descriptor plus its execution binding — one entry of `.vendo/tools.json`. */
export type ExtractedTool = ToolDescriptor & {
  binding: PrimitiveToolBinding;
  /** Fail-closed extraction (04 §1): a route the scanner can't classify is emitted disabled, never silently auto-allowed. */
  disabled?: boolean;
  note?: string;
  /** The host's DECLARED response body, when its source says so (an OpenAPI
   *  2xx `application/json` schema today). Extraction never invents one.
   *
   *  RECORDED ONLY — nothing consumes it yet. Generation's `toolShapes` still
   *  come exclusively from runtime sampling (apps runtime, generationToolContext),
   *  which is ground truth and covers every no-input read tool. The gap this
   *  field is here to close is the tools sampling can NEVER reach — ones that
   *  require input, mutate, or sit behind a policy gate — but feeding declared
   *  schemas into generation changes the prompt for every OpenAPI host at once
   *  and wants its own corpus evidence, so it is deliberately a separate
   *  change. Until then this is committed contract data, not a live input. */
  outputSchema?: JsonSchema;
  /** Who can legitimately call this through the product's own auth —
   *  extraction's provenance for the default exclusion of non-end-user tools. */
  audience?: "end-user" | "operator" | "internal";
  /** Sync-inferred field semantics, keyed by collapsed dot path into the
   *  response (core semantics.ts). Host corrections live in overrides.json. */
  semantics?: Record<string, FieldSemantic>;
  /** The handler-source content hash incremental sync diffs against. */
  srcHash?: string;
};

export const extractedToolSchema = toolDescriptorSchema.extend({
  binding: extractedBindingSchema,
  disabled: z.boolean().optional(),
  note: z.string().optional(),
  outputSchema: jsonSchemaSchema.optional(),
  audience: z.enum(["end-user", "operator", "internal"]).optional(),
  semantics: z.record(fieldSemanticSchema).optional(),
  srcHash: z.string().min(1).optional(),
}).superRefine((tool, context) => {
  if ((tool.binding as { kind?: string }).kind === "compound") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["binding"],
      message: "compound bindings live in .vendo/overrides.json compounds — .vendo/tools.json stays deterministic (04-actions §6)",
    });
  }
}) satisfies z.ZodType<ExtractedTool>;

/** `.vendo/tools.json` — generated, regenerated wholesale by `vendo sync`,
 *  never hand-edited. Passthrough like every generated artifact. */
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
  /** The short human label people see for this tool (MCP client menus,
   *  approval cards). Presentation, not capability — the authored copy is the
   *  last word over whatever sync's enrichment proposed. */
  title?: string;
  /** Who can legitimately call this through the product's own auth. Extraction
   *  records it as provenance for the default exclusion of non-end-user tools
   *  (operator/internal surfaces never reach the embedded agent unreviewed). */
  audience?: "end-user" | "operator" | "internal";
  /** W3 — host-declared field semantics for this tool's RESPONSE, keyed by
   *  collapsed dot path (arrays collapse: `data.amountCents`). The highest
   *  authority in `.vendo/overrides.json`: annotation > sync-time inference. */
  semantics?: Record<string, FieldSemantic>;
}

export const toolOverrideSchema = z.object({
  risk: riskLabelSchema.optional(),
  critical: z.boolean().optional(),
  disabled: z.boolean().optional(),
  description: z.string().optional(),
  title: z.string().min(1).optional(),
  audience: z.enum(["end-user", "operator", "internal"]).optional(),
  semantics: z.record(fieldSemanticSchema).optional(),
}).strict() satisfies z.ZodType<ToolOverride>;

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

/** 04-actions §6: one agent-authored compound tool of `.vendo/overrides.json`. */
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
 * `.vendo/overrides.json` (vendo/overrides@3) — the AUTHORED layer, the only
 * human-edited file: per-tool overrides plus the agent-authored `compounds`
 * and `briefs`, and remix slot opt-outs. Strict on purpose — a typo must fail
 * loudly — except compounds and briefs entries, which keep their passthrough
 * (additive) behavior.
 */
/** The host-curated tool menu for ONE surface. Curation, not security: a menu
 *  decides what a surface OFFERS, never what the guard allows — `disabled`,
 *  guard rules, and audience exclusions are untouched by it. */
export interface SurfaceMenu {
  tools: string[];
}

/** Per-surface menus. The key set is a CLOSED enum on purpose: a typo'd
 *  surface name in an authored file must fail loudly at parse rather than
 *  silently curate nothing. `cli` and friends join when they are real. */
export interface OverridesSurfaces {
  agent?: SurfaceMenu;
  mcp?: SurfaceMenu;
}

const surfaceMenuSchema = z.object({
  tools: z.array(z.string().min(1)),
}).strict() satisfies z.ZodType<SurfaceMenu>;

const overridesSurfacesSchema = z.object({
  agent: surfaceMenuSchema.optional(),
  mcp: surfaceMenuSchema.optional(),
}).strict() satisfies z.ZodType<OverridesSurfaces>;

export interface OverridesFile {
  format: typeof VENDO_OVERRIDES_FORMAT;
  tools: Record<string, ToolOverride>;
  compounds?: CompoundTool[];
  briefs?: CapabilityBrief[];
  surfaces?: OverridesSurfaces;
  remix?: { ignoreSlots: string[] };
}

export const overridesFileSchema = z.object({
  format: z.literal(VENDO_OVERRIDES_FORMAT),
  tools: z.record(toolOverrideSchema),
  compounds: z.array(compoundToolSchema).optional(),
  briefs: z.array(capabilityBriefSchema).optional(),
  surfaces: overridesSurfacesSchema.optional(),
  remix: z.object({
    ignoreSlots: z.array(z.string().min(1)),
  }).strict().optional(),
}).strict() satisfies z.ZodType<OverridesFile>;

/**
 * `.vendo/judgments.json` — the AI layer, the third file of `.vendo/`, split
 * from `tools.json` by AUTHOR the same way `overrides.json` is: the model
 * writes here, the deterministic scanner never does, and a human never has to.
 * Generated, regenerated by the judge pass, keyed by tool name.
 */
export const VENDO_JUDGMENTS_FORMAT = "vendo/judgments@1" as const;

/** The AI-writable surface — same field family as ToolOverride so the three
 *  layers merge with one shape vocabulary. */
export interface JudgmentFields {
  description?: string;
  title?: string;
  risk?: "read" | "write" | "destructive";
  critical?: boolean;
  /** true = harden; false = approved wake-up (only ever arrives here after a
   *  human accepted the queued loosening — the model cannot write it itself). */
  disabled?: boolean;
  audience?: "end-user" | "operator" | "internal";
  semantics?: Record<string, FieldSemantic>;
}

export const judgmentFieldsSchema = z.object({
  description: z.string().max(500).optional(),
  title: z.string().min(1).max(60).optional(),
  risk: riskLabelSchema.optional(),
  critical: z.boolean().optional(),
  disabled: z.boolean().optional(),
  audience: z.enum(["end-user", "operator", "internal"]).optional(),
  semantics: z.record(fieldSemanticSchema).optional(),
  // STRICT like its sibling `toolOverrideSchema`: this is the whole AI-writable
  // surface, and `applyJudgment` spreads it onto the tool. A passthrough here
  // would let a model smuggle `binding` or `inputSchema` into a judgment and
  // rewrite the deterministic skeleton. Identity is not expressible.
}).strict() satisfies z.ZodType<JudgmentFields>;

/** One queued loosening awaiting human review. NEVER merged at runtime: the
 *  only fields a loosening can touch are the four capability grades, and each
 *  one costs a quoted piece of evidence. */
export interface PendingLoosening {
  field: "risk" | "critical" | "disabled" | "audience";
  value: string | boolean;
  evidence: string;
  reason?: string;
}

export const pendingLooseningSchema = z.object({
  field: z.enum(["risk", "critical", "disabled", "audience"]),
  value: z.union([z.string(), z.boolean()]),
  evidence: z.string().min(1).max(500),
  reason: z.string().max(300).optional(),
}).passthrough() satisfies z.ZodType<PendingLoosening>;

export interface ToolJudgment {
  /** bindingIdentity(tool.binding) at judgment time — a mismatch makes the
   *  whole entry inert rather than applying a judgment of another handler. */
  binding: string;
  srcHash?: string;
  fields: JudgmentFields;
  /** The quoted handler snippet the judgment rests on. REQUIRED: a grade with
   *  no evidence is an opinion, and opinions do not move capability. */
  evidence: string;
  pending?: PendingLoosening[];
}

export const toolJudgmentSchema = z.object({
  binding: z.string().min(1),
  srcHash: z.string().min(1).optional(),
  fields: judgmentFieldsSchema,
  evidence: z.string().min(1).max(500),
  pending: z.array(pendingLooseningSchema).optional(),
}).passthrough() satisfies z.ZodType<ToolJudgment>;

export interface JudgmentsFile {
  format: typeof VENDO_JUDGMENTS_FORMAT;
  tools: Record<string, ToolJudgment>;
}

/** Passthrough at the file level (generated-artifact convention), but every
 *  bound above is load-bearing: this file can carry DISABLES, so a malformed
 *  one must fail loudly at parse. Silently ignoring it would silently loosen. */
export const judgmentsFileSchema = z.object({
  format: z.literal(VENDO_JUDGMENTS_FORMAT),
  tools: z.record(toolJudgmentSchema),
}).passthrough() satisfies z.ZodType<JudgmentsFile>;

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

/** 04-actions §1 */
export interface SyncReport {
  tools: { added: string[]; removed: string[]; changed: string[] };
  breaking: BreakingChange[];
  pins: { captured: string[]; drifted: string[] };
  catalog: { discovered: number; registered: number };
}
