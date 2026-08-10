import { z } from "zod";
import {
  fieldSemanticSchema,
  jsonSchemaSchema,
  riskLabelSchema,
  stepSchema,
  toolDescriptorSchema,
  type FieldSemantic,
  type JsonSchema,
  type RiskLabel,
  type Step,
  type ToolDescriptor,
} from "@vendoai/core";

/**
 * `confirmEach` was called `critical` before the risk-grading redesign (D5).
 * Every WRITER emits the new name; every host-authored file keeps reading the
 * old one, indefinitely — the same read-old/write-new shape persisted data
 * always gets. Applied at the file schemas rather than inside `ToolDescriptor`
 * so the strict authored schemas (a typo must still fail loudly) accept the
 * one legacy spelling and nothing else. An explicit `confirmEach` wins.
 */
function readCriticalAlias(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!("critical" in record)) return value;
  const { critical, ...rest } = record;
  return { confirmEach: critical, ...rest };
}

/** The same alias for `PendingLoosening.field`, whose value NAMES the field. */
function readCriticalFieldAlias(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return record.field === "critical" ? { ...record, field: "confirmEach" } : value;
}

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
export type PrimitiveToolBinding = RouteBinding | OpenApiBinding | TrpcBinding | ServerActionBinding;

export type ToolBinding = RouteBinding | OpenApiBinding | TrpcBinding | ServerActionBinding | CompoundBinding;

export const toolBindingSchema = z.union([
  routeBindingSchema,
  openApiBindingSchema,
  trpcBindingSchema,
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

/** Which rung of the trust ladder produced a schema. "unknown" is explicit, not
 *  absence: `inputSchema` is REQUIRED on every descriptor (core tools.ts), so
 *  only this can tell a derived no-argument schema from one nothing could read.
 *  It is also the AI fill gate — `patchToolSchemas` refuses an occupied slot. */
export type SchemaSource = "declared" | "types" | "inferred" | "unknown";

export const schemaSourceSchema = z.enum(["declared", "types", "inferred", "unknown"]) satisfies z.ZodType<SchemaSource>;

/** Absent ≡ "unknown": a pre-marker file reads as blind. */
export const schemaIsBlind = (source: SchemaSource | undefined): boolean => (source ?? "unknown") === "unknown";

/** 04-actions §2: a descriptor plus its execution binding — one entry of `.vendo/tools.json`.
 *
 *  `outputSchema` (the host's DECLARED response body, recorded by sync) is a plain
 *  `ToolDescriptor` field, not extraction-only provenance: the registry carries it
 *  and every surface lists it. Generation's `toolShapes` are built from it
 *  (`shapeFromJsonSchema`) — nothing samples the host anymore. */
export type ExtractedTool = ToolDescriptor & {
  binding: PrimitiveToolBinding;
  /** Fail-closed extraction (04 §1): a route the scanner can't classify is emitted disabled, never silently auto-allowed. */
  disabled?: boolean;
  note?: string;
  /** Who can legitimately call this through the product's own auth —
   *  extraction's provenance for the default exclusion of non-end-user tools. */
  audience?: "end-user" | "operator" | "internal";
  /** Sync-inferred field semantics, keyed by collapsed dot path into the
   *  response (core semantics.ts). Host corrections live in overrides.json. */
  semantics?: Record<string, FieldSemantic>;
  /** Which rung of the trust ladder filled each schema slot. Absent = a
   *  pre-marker file, read as "unknown". Machine layer and reports only —
   *  never forwarded to `descriptors()` (registry.ts's descriptor whitelist). */
  inputSchemaSource?: SchemaSource;
  outputSchemaSource?: SchemaSource;
  /** The handler-source content hash incremental sync diffs against. */
  srcHash?: string;
};

export const extractedToolSchema = z.preprocess(readCriticalAlias, toolDescriptorSchema.extend({
  binding: extractedBindingSchema,
  disabled: z.boolean().optional(),
  note: z.string().optional(),
  audience: z.enum(["end-user", "operator", "internal"]).optional(),
  semantics: z.record(fieldSemanticSchema).optional(),
  inputSchemaSource: schemaSourceSchema.optional(),
  outputSchemaSource: schemaSourceSchema.optional(),
  srcHash: z.string().min(1).optional(),
}).superRefine((tool, context) => {
  if ((tool.binding as { kind?: string }).kind === "compound") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["binding"],
      message: "compound bindings live in .vendo/overrides.json compounds — .vendo/tools.json stays deterministic (04-actions §6)",
    });
  }
})) satisfies z.ZodType<ExtractedTool, z.ZodTypeDef, unknown>;

/** `.vendo/tools.json` — generated, regenerated wholesale by `vendo sync`,
 *  never hand-edited. Passthrough like every generated artifact. */
export interface ToolsFile {
  format: typeof VENDO_TOOLS_FORMAT;
  tools: ExtractedTool[];
}

export const toolsFileSchema = z.object({
  format: z.literal(VENDO_TOOLS_FORMAT),
  tools: z.array(extractedToolSchema),
}).passthrough() satisfies z.ZodType<ToolsFile, z.ZodTypeDef, unknown>;

/**
 * `.vendo/overrides.json` — human-written, respected forever (04 §1).
 * Strict on purpose: a typo in a hand-written override must fail loudly,
 * never be silently ignored.
 */
export interface ToolOverride {
  risk?: ToolDescriptor["risk"];
  confirmEach?: boolean;
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

export const toolOverrideSchema = z.preprocess(readCriticalAlias, z.object({
  risk: riskLabelSchema.optional(),
  confirmEach: z.boolean().optional(),
  disabled: z.boolean().optional(),
  description: z.string().optional(),
  title: z.string().min(1).optional(),
  audience: z.enum(["end-user", "operator", "internal"]).optional(),
  semantics: z.record(fieldSemanticSchema).optional(),
}).strict()) satisfies z.ZodType<ToolOverride, z.ZodTypeDef, unknown>;

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

export const compoundToolSchema = z.preprocess(readCriticalAlias, toolDescriptorSchema.extend({
  binding: compoundBindingSchema,
  disabled: z.boolean().optional(),
  note: z.string().optional(),
})) satisfies z.ZodType<CompoundTool, z.ZodTypeDef, unknown>;

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
}).strict() satisfies z.ZodType<OverridesFile, z.ZodTypeDef, unknown>;

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
  risk?: RiskLabel;
  confirmEach?: boolean;
  /** true = harden; false = approved wake-up (only ever arrives here after a
   *  human accepted the queued loosening — the model cannot write it itself). */
  disabled?: boolean;
  audience?: "end-user" | "operator" | "internal";
  semantics?: Record<string, FieldSemantic>;
}

export const judgmentFieldsSchema = z.preprocess(readCriticalAlias, z.object({
  description: z.string().max(500).optional(),
  title: z.string().min(1).max(60).optional(),
  risk: riskLabelSchema.optional(),
  confirmEach: z.boolean().optional(),
  disabled: z.boolean().optional(),
  audience: z.enum(["end-user", "operator", "internal"]).optional(),
  semantics: z.record(fieldSemanticSchema).optional(),
  // STRICT like its sibling `toolOverrideSchema`: this is the whole AI-writable
  // surface, and `applyJudgment` spreads it onto the tool. A passthrough here
  // would let a model smuggle `binding` or `inputSchema` into a judgment and
  // rewrite the deterministic skeleton. Identity is not expressible.
}).strict()) satisfies z.ZodType<JudgmentFields, z.ZodTypeDef, unknown>;

/** One queued loosening awaiting human review. NEVER merged at runtime: the
 *  only fields a loosening can touch are the four capability grades, and each
 *  one costs a quoted piece of evidence. */
export interface PendingLoosening {
  field: "risk" | "confirmEach" | "disabled" | "audience";
  value: string | boolean;
  evidence: string;
  reason?: string;
}

export const pendingLooseningSchema = z.preprocess(readCriticalFieldAlias, z.object({
  field: z.enum(["risk", "confirmEach", "disabled", "audience"]),
  value: z.union([z.string(), z.boolean()]),
  evidence: z.string().min(1).max(500),
  reason: z.string().max(300).optional(),
}).passthrough()) satisfies z.ZodType<PendingLoosening, z.ZodTypeDef, unknown>;

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
}).passthrough() satisfies z.ZodType<ToolJudgment, z.ZodTypeDef, unknown>;

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
}).passthrough() satisfies z.ZodType<JudgmentsFile, z.ZodTypeDef, unknown>;

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
  /** True when the `<Remixable review>` wrapper marks this a reviewed-kind
   *  component: remixes stay invisible until a host reviewer approves. */
  review?: boolean;
  /** Import specifier -> captured module id for imports in the primary source. */
  sourceImports?: Record<string, string>;
  /** Source-owned modules reachable within two local-import hops. */
  subSources?: Record<string, CapturedPinSubSource>;
  /** No longer written by sync (live props seed forks now); kept optional so
   *  legacy baseline files stay valid. */
  sampleProps?: Record<string, unknown>;
  /** Direct CSS imports from canonical app root files, in deterministic order. */
  styles?: CapturedPinStyle[];
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
  review: z.boolean().optional(),
  sourceImports: z.record(z.string()).optional(),
  subSources: z.record(capturedPinSubSourceSchema).optional(),
  sampleProps: z.record(z.unknown()).optional(),
  styles: z.array(capturedPinStyleSchema).optional(),
}).passthrough() satisfies z.ZodType<CapturedPinBaseline>;

/**
 * The component-bundle format (`CapturedModule`, `CapturedHostComponent` and
 * their schemas) lives on the contract door — `@vendoai/apps/contract` — because
 * the console and the jail renderer read the same bytes from the browser. Sync
 * writes them; re-exported here so this package's surface is unchanged.
 */
export {
  capturedHostComponentSchema,
  capturedModuleSchema,
  hostComponentEntrySource,
  HOST_COMPONENT_SKIP_REASONS,
  type CapturedHostComponent,
  type CapturedModule,
  type HostComponentSampleGap,
  type HostComponentSkip,
  type HostComponentSkipReason,
} from "@vendoai/apps/contract";


/** 04-actions §1 */
export interface BreakingChange {
  tool: string;
  change: "removed" | "input-narrowed" | "renamed";
}

/** 04-actions §1 */
export interface SyncReport {
  tools: { added: string[]; removed: string[]; changed: string[] };
  breaking: BreakingChange[];
  /** `pruned` (absent when empty) — stale baselines deleted because no
   *  `<Remixable>` wrapper names their slot anymore. */
  pins: { captured: string[]; drifted: string[]; pruned?: string[] };
  catalog: { discovered: number; registered: number };
  /** Registered host components whose source sync captured, so the console can
   *  render them for real. `skipped` = could not be captured at all;
   *  `withoutSamples` = captured, but the registration declares no usable
   *  `examples`, so a preview can only show a labeled placeholder. */
  components: {
    captured: string[];
    drifted: string[];
    pruned?: string[];
    skipped?: string[];
    withoutSamples?: string[];
  };
  /** Schema coverage across the whole catalog, BOTH slots. `unknown` names the
   *  blind tools by name because a count alone is not actionable: the agent
   *  must pass those outputs through whole and cannot know their arguments. */
  toolSchemas: {
    total: number;
    inputs: { known: number; unknown: string[] };
    outputs: { known: number; unknown: string[] };
  };
}
