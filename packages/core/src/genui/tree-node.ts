import { z } from "zod";
import type { Json } from "../ids.js";

export {
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_TOTAL_COMPONENT_BYTES,
  TREE_MAX_COMPONENT_SOURCE_CHARS,
  TREE_MAX_TOTAL_COMPONENT_CHARS,
} from "./tree-limits.js";

import type { ReshapeStep } from "../reshape.js";

/** 01-core §8; `$reshape` is v2 spec §3 — an optional bounded reshape chain
 *  (additive: every existing consumer keeps working; the format gate validates
 *  the chain, and the renderer applies it on resolution). */
export interface PathBinding {
  $path: string;
  $reshape?: ReshapeStep[];
}

/** 01-core §8; `$reshape` as on {@link PathBinding} (v2 spec §3). */
export interface StateBinding {
  $state: string;
  $reshape?: ReshapeStep[];
}

/** 01-core §8 */
export function isPathBinding(value: unknown): value is PathBinding {
  return typeof value === "object"
    && value !== null
    && typeof (value as { $path?: unknown }).$path === "string";
}

/** 01-core §8 */
export function isStateBinding(value: unknown): value is StateBinding {
  return typeof value === "object"
    && value !== null
    && typeof (value as { $state?: unknown }).$state === "string";
}

/** 01-core §8 */
export interface UIPayload {
  formatVersion: string;
  [key: string]: unknown;
}

/** 01-core §8 */
export const uiPayloadSchema = z.object({
  formatVersion: z.string(),
}).passthrough() satisfies z.ZodType<UIPayload>;

/** 01-core §8 */
export interface TreeNode {
  id: string;
  component: string;
  /** Where the painted component came from. `ported` is a component the splitter
   *  ported from host source, as opposed to `generated`, which the model wrote
   *  from scratch — the marker that lets the renderer honor `className` on
   *  ported nodes only. */
  source?: "prewired" | "host" | "generated" | "ported";
  props?: Record<string, Json>;
  children?: string[];
}

/** 01-core §8 */
export const treeNodeSchema = z.object({
  id: z.string(),
  component: z.string(),
  source: z.enum(["prewired", "host", "generated", "ported"]).optional(),
  props: z.record(z.unknown()).optional(),
  children: z.array(z.string()).optional(),
}).passthrough() satisfies z.ZodType<TreeNode>;

/** The vocabulary itself, DERIVED from the schema above rather than written out
 *  a second time — the two validators that walk a tree by hand instead of by zod
 *  (apps genui/tree.ts, ui tree/renderer.tsx) read it from here. Three
 *  hand-written copies is how `ported` came to be legal in one and refused by the
 *  other two. */
export const TREE_NODE_SOURCES: readonly string[] = treeNodeSchema.shape.source.unwrap().options;

/** The one canonical non-null, non-array object guard (kill-list B6) — every
 *  package already depends on core, so a per-file redefinition is duplication,
 *  not a layering workaround. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The one canonical own-property define (the isPlainObject precedent): a
 *  wire/sample key named __proto__ must become data, never the record's
 *  prototype. */
export const defineOwn = <T>(record: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
};

