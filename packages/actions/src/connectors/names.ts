import { sha256Hex } from "@vendoai/core";

const MAX_TOOL_NAME_LENGTH = 64;

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
}

/** Normalize a provider tool name into the shared core tool-name namespace. */
export function normalizeToolName(prefix: string, raw: string): string {
  const full = sanitize(`${prefix.toLowerCase()}_${raw}`);
  if (full.length <= MAX_TOOL_NAME_LENGTH) return full;
  return `${full.slice(0, 57)}_${sha256Hex(full).slice(0, 6)}`;
}
