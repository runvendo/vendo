/** 01-core §8 — the pinned vendo-genui/v1 limits and reserved names. */

/** 01-core §8 */
export const TREE_MAX_NODES = 5_000;

/** 01-core §8 */
export const TREE_MAX_QUERIES = 16;

/** 01-core §8 */
export const TREE_MAX_GENERATED_COMPONENTS = 16;

/** 01-core §8 */
export const TREE_MAX_COMPONENT_SOURCE_CHARS = 65_536;

/** 01-core §8 */
export const TREE_MAX_TOTAL_COMPONENT_CHARS = 262_144;

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
