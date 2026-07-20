import { VendoError } from "./errors.js";

const unsupported = (message: string): never => {
  throw new VendoError("validation", message);
};

/** ES2024 String.prototype.isWellFormed — guaranteed at runtime by the
 *  package's engines floor (node >= 20) but absent from this tsconfig's
 *  ES2022 lib, hence the local cast. The one lone-surrogate detector in the
 *  package: canonicalJson rejects ill-formed strings below, and the wire-v2
 *  compiler (state.ts) keeps them out of props/islands so this never throws
 *  downstream. */
export const isWellFormedUtf16 = (text: string): boolean =>
  (text as string & { isWellFormed(): boolean }).isWellFormed();

/** RFC 8785 §3.2.2.2 requires well-formed Unicode; a lone surrogate would hash
 *  differently across implementations (strict ones reject it outright). */
const assertWellFormed = (value: string): string => {
  if (!isWellFormedUtf16(value)) unsupported("canonical JSON does not support lone surrogates");
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
        // Default Array.prototype.sort compares UTF-16 code units — exactly the
        // property-name ordering RFC 8785 §3.2.3 mandates. (The subtlety is
        // surrogate pairs: "😀" (D83D DE00) sorts BEFORE "דּ" (FB33) because
        // comparison is per code UNIT, not code point — covered by the vectors.)
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
