import type { Json } from "@vendoai/core";

/** 01-core §8 — resolve an RFC 6901 JSON Pointer (`""` is the whole model). */
export function resolvePointer(model: Json, pointer: string): Json | undefined {
  if (pointer === "") return model;
  if (!pointer.startsWith("/")) return undefined;

  let current: unknown = model;
  for (const encodedToken of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(encodedToken)) return undefined;
    const token = encodedToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if ((typeof current !== "object" || current === null)
      || !Object.prototype.hasOwnProperty.call(current, token)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}
