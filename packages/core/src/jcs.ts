import { VendoError } from "./errors.js";

const unsupported = (message: string): never => {
  throw new VendoError("validation", message);
};

const serialize = (value: unknown, stack: Set<object>, position: "top" | "object" | "array"): string | undefined => {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
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
        const entries: string[] = [];
        for (const key of Object.keys(value).sort()) {
          const serialized = serialize((value as Record<string, unknown>)[key], stack, "object");
          if (serialized !== undefined) entries.push(`${JSON.stringify(key)}:${serialized}`);
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
