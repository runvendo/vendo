import type { Json } from "@vendoai/core";

/** A Kit control may hand the press its OWN arguments — the id of the row the
 *  button sits on — which merge over the declared payload. Only a plain object
 *  literal counts: the Kit's other bound handlers hand over a string
 *  (input/textarea/date-picker/select), a boolean (checkbox) or a React event
 *  (form), and none of those has Object.prototype. */
export function withPressArgs(declared: Json | undefined, extra: unknown): Json | undefined {
  if (extra === null || typeof extra !== "object" || Object.getPrototypeOf(extra) !== Object.prototype) {
    return declared;
  }
  return { ...(declared as Record<string, Json> | undefined), ...(extra as Record<string, Json>) };
}

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
