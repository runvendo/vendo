/**
 * Internal: the generated-component map rules shared by the tree validator
 * (wire, 01-core §8) and the app-document validator (at rest, 01-core §9 —
 * components live one level up). Not exported from the package root.
 */
import {
  RESERVED_COMPONENT_NAMES,
  TREE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_TOTAL_COMPONENT_BYTES,
} from "./tree-limits.js";

const COMPONENT_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

// CORE-6: the contract pins the caps in kilobytes; measure encoded UTF-8, not
// UTF-16 code units (multibyte sources are up to 3x larger encoded). One
// module-level encoder -- componentMapError sits under validateTree on the
// render hot path -- and pure-ASCII sources (bytes === chars) skip encoding.
const utf8 = new TextEncoder();
const NON_ASCII_PATTERN = /[\u0080-\uffff]/;
export const utf8ByteLength = (source: string): number =>
  NON_ASCII_PATTERN.test(source) ? utf8.encode(source).length : source.length;

/** Returns an error message, or null when the map honors every pinned limit. */
export function componentMapError(components: Record<string, unknown>): string | null {
  const names = Object.keys(components);
  if (names.length > TREE_MAX_GENERATED_COMPONENTS) {
    return `too many generated components (max ${TREE_MAX_GENERATED_COMPONENTS})`;
  }
  let totalBytes = 0;
  for (const name of names) {
    if (!COMPONENT_NAME_PATTERN.test(name)) {
      return `generated component name "${name}" must be a PascalCase identifier`;
    }
    if ((RESERVED_COMPONENT_NAMES as readonly string[]).includes(name)) {
      return `generated component name "${name}" is reserved (prewired primitive)`;
    }
    const source = components[name];
    if (typeof source !== "string") {
      return `generated component "${name}" source must be a string`;
    }
    const sourceBytes = utf8ByteLength(source);
    if (sourceBytes > TREE_MAX_COMPONENT_SOURCE_BYTES) {
      return `generated component "${name}" source too large (max ${TREE_MAX_COMPONENT_SOURCE_BYTES} bytes)`;
    }
    totalBytes += sourceBytes;
  }
  if (totalBytes > TREE_MAX_TOTAL_COMPONENT_BYTES) {
    return `generated component sources too large in total (max ${TREE_MAX_TOTAL_COMPONENT_BYTES} bytes)`;
  }
  return null;
}
