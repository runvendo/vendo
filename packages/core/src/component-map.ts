/**
 * Internal: the generated-component map rules shared by the tree validator
 * (wire, 01-core §8) and the app-document validator (at rest, 01-core §9 —
 * components live one level up). Not exported from the package root.
 */
import {
  RESERVED_COMPONENT_NAMES,
  TREE_MAX_COMPONENT_SOURCE_CHARS,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_TOTAL_COMPONENT_CHARS,
} from "./tree-limits.js";

const COMPONENT_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

/** Returns an error message, or null when the map honors every pinned limit. */
export function componentMapError(components: Record<string, unknown>): string | null {
  const names = Object.keys(components);
  if (names.length > TREE_MAX_GENERATED_COMPONENTS) {
    return `too many generated components (max ${TREE_MAX_GENERATED_COMPONENTS})`;
  }
  let totalChars = 0;
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
    if (source.length > TREE_MAX_COMPONENT_SOURCE_CHARS) {
      return `generated component "${name}" source too large (max ${TREE_MAX_COMPONENT_SOURCE_CHARS} chars)`;
    }
    totalChars += source.length;
  }
  if (totalChars > TREE_MAX_TOTAL_COMPONENT_CHARS) {
    return `generated component sources too large in total (max ${TREE_MAX_TOTAL_COMPONENT_CHARS} chars)`;
  }
  return null;
}
