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
