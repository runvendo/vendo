import { z } from "zod";
import {
  VENDO_OVERRIDES_FORMAT,
  VENDO_TOOLS_FORMAT,
  riskLabelSchema,
  toolDescriptorSchema,
  type ToolDescriptor,
} from "@vendoai/core";

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

export type ToolBinding = RouteBinding | OpenApiBinding;

export const toolBindingSchema = z.discriminatedUnion("kind", [
  routeBindingSchema,
  openApiBindingSchema,
]) satisfies z.ZodType<ToolBinding>;

/** 04-actions §2: a descriptor plus its execution binding — one entry of `.vendo/tools.json`. */
export type ExtractedTool = ToolDescriptor & {
  binding: ToolBinding;
  /** Fail-closed extraction (04 §1): a route the scanner can't classify is emitted disabled, never silently auto-allowed. */
  disabled?: boolean;
  note?: string;
};

export const extractedToolSchema = toolDescriptorSchema.extend({
  binding: toolBindingSchema,
  disabled: z.boolean().optional(),
  note: z.string().optional(),
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
}

export const overridesFileSchema = z.object({
  format: z.literal(VENDO_OVERRIDES_FORMAT),
  tools: z.record(toolOverrideSchema),
}).strict() satisfies z.ZodType<OverridesFile>;

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
}
