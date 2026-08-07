import type { Json, ToolOutcome } from "@vendoai/core";

/** Shared ToolOutcome error envelope for the actions runtime. */
export function error(code: string, message: string): ToolOutcome {
  return { status: "error", error: { code, message } };
}

/** Tool call arguments must be a plain object (01-core §4 convention). */
export function isArgsObject(value: unknown): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
