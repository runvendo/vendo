/** 01-core §8 — the pinned vendo-genui tree limits and reserved names. */

/** 01-core §8 */
export const TREE_MAX_NODES = 5_000;

/** 01-core §8 */
export const TREE_MAX_QUERIES = 16;

/** 01-core §8 */
export const TREE_MAX_GENERATED_COMPONENTS = 16;

/** 01-core §8 — 64 KB per component source, measured in UTF-8 BYTES (CORE-6:
 *  the contract pins kilobytes, not UTF-16 code units). */
export const TREE_MAX_COMPONENT_SOURCE_BYTES = 65_536;

/** 01-core §8 — 256 KB total generated-component source, in UTF-8 BYTES. */
export const TREE_MAX_TOTAL_COMPONENT_BYTES = 262_144;

/** @deprecated CORE-6: the cap is enforced in bytes — use
 *  {@link TREE_MAX_COMPONENT_SOURCE_BYTES}. Same value, kept for importers. */
export const TREE_MAX_COMPONENT_SOURCE_CHARS = TREE_MAX_COMPONENT_SOURCE_BYTES;

/** @deprecated CORE-6: the cap is enforced in bytes — use
 *  {@link TREE_MAX_TOTAL_COMPONENT_BYTES}. Same value, kept for importers. */
export const TREE_MAX_TOTAL_COMPONENT_CHARS = TREE_MAX_TOTAL_COMPONENT_BYTES;

/** 01-core §8 */
export const RESERVED_COMPONENT_NAMES = [
  "Stack",
  "Row",
  "Grid",
  "Text",
  "Skeleton",
  "Surface",
  "Divider",
] as const;

/** 01-core §8 / v2 spec §2 — the branded prewired components beyond the
 *  reserved layout primitives. ONE list, mirrored by the implementations in
 *  packages/ui/src/tree/branded.tsx (core cannot import ui); the wire
 *  compiler's source resolution and the engine's catalog validation must
 *  agree on it (verify-v2 fixes: they did not). */
export const BRANDED_COMPONENT_NAMES = [
  "Card",
  "Button",
  "Input",
  "Select",
  "Table",
  "Badge",
  "Stat",
  "Tabs",
] as const;

/** The full prewired set a tree node may resolve to without a source map. */
export const PREWIRED_COMPONENT_NAMES = [
  ...RESERVED_COMPONENT_NAMES,
  ...BRANDED_COMPONENT_NAMES,
] as const;
