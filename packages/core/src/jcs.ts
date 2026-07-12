import { VendoError } from "./errors.js";

const unsupported = (message: string): never => {
  throw new VendoError("validation", message);
};

const SURROGATE_PATTERN = /[\uD800-\uDFFF]/;

/** RFC 8785 §3.2.2.2 requires well-formed Unicode; a lone surrogate would hash
 *  differently across implementations (strict ones reject it outright). */
const assertWellFormed = (value: string): string => {
  if (!SURROGATE_PATTERN.test(value)) return value;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      unsupported("canonical JSON does not support lone surrogates");
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      unsupported("canonical JSON does not support lone surrogates");
    }
  }
  return value;
};

const serialize = (value: unknown, stack: Set<object>, position: "top" | "object" | "array"): string | undefined => {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(assertWellFormed(value));
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) unsupported("canonical JSON does not support non-finite numbers");
      return JSON.stringify(value);
    case "bigint":
      return unsupported("canonical JSON does not support bigint");
    case "undefined":
    case "function":
    case "symbol":
      if (position === "object") return undefined;
      if (position === "array") return "null";
      return unsupported("canonical JSON requires a JSON-serializable top-level value");
    case "object": {
      if (stack.has(value)) unsupported("canonical JSON does not support cyclic values");
      stack.add(value);
      try {
        if (Array.isArray(value)) {
          const items = Array.from(
            { length: value.length },
            (_, index) => serialize(value[index], stack, "array") ?? "null",
          );
          return `[${items.join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== null && prototype !== Object.prototype) {
          // Dates, Maps, class instances, etc. are not JSON data — ECMAScript's
          // JSON.stringify and strict RFC 8785 implementations would disagree here.
          unsupported("canonical JSON requires plain objects and arrays");
        }
        const entries: string[] = [];
        for (const key of Object.keys(value).sort()) {
          const serialized = serialize((value as Record<string, unknown>)[key], stack, "object");
          if (serialized !== undefined) entries.push(`${JSON.stringify(assertWellFormed(key))}:${serialized}`);
        }
        return `{${entries.join(",")}}`;
      } finally {
        stack.delete(value);
      }
    }
    default:
      return unsupported("canonical JSON encountered an unsupported value");
  }
};

/** 01-core §4 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set<object>(), "top")
    ?? unsupported("canonical JSON requires a JSON-serializable value");
}
