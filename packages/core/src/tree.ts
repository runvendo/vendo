import { z } from "zod";
import type { Json } from "./ids.js";
import { TREE_MAX_NODES, TREE_MAX_QUERIES } from "./tree-limits.js";

export {
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_TOTAL_COMPONENT_BYTES,
  TREE_MAX_COMPONENT_SOURCE_CHARS,
  TREE_MAX_TOTAL_COMPONENT_CHARS,
  RESERVED_COMPONENT_NAMES,
  BRANDED_COMPONENT_NAMES,
  PREWIRED_COMPONENT_NAMES,
} from "./tree-limits.js";

import type { ReshapeStep } from "./reshape.js";

/** 01-core §8; `$reshape` is v2 spec §3 — an optional bounded reshape chain
 *  (additive: every existing consumer keeps working; the v2 gate validates
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
  source?: "prewired" | "host" | "generated";
  props?: Record<string, Json>;
  children?: string[];
}

/** 01-core §8 */
export const treeNodeSchema = z.object({
  id: z.string(),
  component: z.string(),
  source: z.enum(["prewired", "host", "generated"]).optional(),
  props: z.record(z.unknown()).optional(),
  children: z.array(z.string()).optional(),
}).passthrough() satisfies z.ZodType<TreeNode>;

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

