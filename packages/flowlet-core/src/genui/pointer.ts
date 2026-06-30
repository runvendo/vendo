/** RFC 6901 JSON-Pointer primitives for the Flowlet GenUI data model.
 *  Pure functions: resolve a pointer to a value (for `$path` bindings) and
 *  apply an immutable patch (for streaming `ui-delta` updates). No deps, no DOM. */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Maximum number of reference tokens a pointer may have. A pointer over this
 *  many segments is treated as a miss/no-op (never resolved or patched) to bound
 *  work and recursion on untrusted input. */
const MAX_POINTER_TOKENS = 256;

/** Unescape a single reference token per RFC 6901: `~1`→`/` then `~0`→`~`. */
const unescapeToken = (token: string): string =>
  token.replace(/~1/g, "/").replace(/~0/g, "~");

/** Split a pointer into its decoded reference tokens. Assumes a leading `/`. */
const tokenize = (pointer: string): string[] =>
  pointer.slice(1).split("/").map(unescapeToken);

/**
 * Resolve a JSON Pointer against `data`. Empty pointer returns `data` whole.
 * Returns `undefined` for any missing key/index, descent into a non-container,
 * or an invalid (non-empty, non-`/`-prefixed) pointer. Never throws.
 */
export function resolvePointer(data: unknown, pointer: string): unknown {
  if (pointer === "") return data;
  if (pointer[0] !== "/") return undefined;

  const tokens = tokenize(pointer);
  if (tokens.length > MAX_POINTER_TOKENS) return undefined;

  let current: unknown = data;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
    } else if (isObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return undefined;
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Immutably set/delete `value` at the head of `tokens` (non-empty) inside `node`. */
function patchNode(node: unknown, tokens: string[], value: unknown, isDelete: boolean): unknown {
  const [token, ...rest] = tokens;
  const leaf = rest.length === 0;

  if (Array.isArray(node)) {
    const index = Number(token);
    if (!Number.isInteger(index) || index < 0) return node;

    if (leaf) {
      const copy = node.slice();
      if (isDelete) {
        if (index < copy.length) copy.splice(index, 1);
      } else if (index <= copy.length) {
        copy[index] = value; // replace in-range, or append when index === length
      }
      return copy;
    }

    if (index >= node.length) return node; // cannot descend into a missing element
    const copy = node.slice();
    copy[index] = patchNode(node[index], rest, value, isDelete);
    return copy;
  }

  // Treat anything that is not an array as a plain object container; a missing
  // intermediate (non-object) is replaced by a fresh object so paths can form.
  const base = isObject(node) ? node : {};
  const key = token as string;

  if (leaf) {
    if (isDelete) {
      if (!Object.prototype.hasOwnProperty.call(base, key)) return node;
      const copy = { ...base };
      delete copy[key];
      return copy;
    }
    return { ...base, [key]: value };
  }

  return { ...base, [key]: patchNode(base[key], rest, value, isDelete) };
}

/**
 * Immutably apply a patch at `pointer`. Omitting `value` deletes the target
 * (object key removed, array element spliced); otherwise it is set (array
 * indices replace in-range or append at `length`). Missing intermediate object
 * segments are created. Patching the root (`""`) with a value replaces the
 * whole model; a root delete is a no-op. Inputs are never mutated.
 */
export function applyPointerPatch<T extends Record<string, unknown>>(
  data: T,
  pointer: string,
  value?: unknown,
): Record<string, unknown> {
  const isDelete = arguments.length < 3;

  if (pointer === "") {
    if (isDelete) return data;
    return value as Record<string, unknown>;
  }
  if (pointer[0] !== "/") return data;

  const tokens = tokenize(pointer);
  // An over-long pointer is a no-op: bound recursion on untrusted input.
  if (tokens.length > MAX_POINTER_TOKENS) return data;

  return patchNode(data, tokens, value, isDelete) as Record<string, unknown>;
}
