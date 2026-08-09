/**
 * The `vendo_*` tool arguments, checked before any door is touched.
 *
 * Internal to the agent-tool registry (`agent-tools.ts` and its handler
 * modules) — the doors themselves take typed input.
 */
import {
  appIdSchema,
  VendoError,
  type AppDocument,
  type Json,
  type RunContext,
} from "@vendoai/core";
import type { AppsRuntime } from "./types.js";

export const input = (
  value: Json,
  required: string[],
  optional: string[] = [],
): Record<string, Json> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", "tool input must be an object");
  }
  const record = value as Record<string, Json>;
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected !== undefined) throw new VendoError("validation", `unexpected input property: ${unexpected}`);
  for (const key of required) {
    if (typeof record[key] !== "string" || (record[key] as string).trim() === "") {
      throw new VendoError("validation", `${key} must be a non-empty string`);
    }
  }
  return record;
};

export const optionalString = (value: Json | undefined, name: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new VendoError("validation", `${name} must be a non-empty string`);
  }
  return value;
};

export const optionalRefs = (value: Json | undefined): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", "refs must be an object");
  }
  const refs: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "" || typeof item !== "string" || item.trim() === "") {
      throw new VendoError("validation", "refs must have non-empty string keys and values");
    }
    refs[key] = item;
  }
  return refs;
};

export const optionalLimit = (value: Json | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new VendoError("validation", "limit must be a positive integer");
  }
  return value;
};

/**
 * The `app` slot as a person says it: an app id, or the app's NAME.
 *
 * A fresh thread holds no ids — "add a weekly one to the transactions app" is
 * the whole ask, and until now it died on the way in, because `app` took an id
 * and nothing in this registry lists or searches. The aim already has a slot;
 * this is that slot understanding the name the user actually said.
 *
 * Exact name first, then case-insensitively, over THIS caller's own apps (the
 * same owned ∪ granted list every other door reads). Two apps of one name is a
 * question, never a coin toss: the candidates come back in the refusal so the
 * model can ask which one. And a ref that matches no name is handed on
 * untouched, so "no such app" and "you may not change that one" stay the
 * runtime's own sentences.
 */
export const resolveAppRef = async (
  runtime: AppsRuntime,
  ref: string,
  ctx: RunContext,
): Promise<string> => {
  // An id is an id (core's own shape). Nothing is listed for the common path.
  if (appIdSchema.safeParse(ref).success) return ref;
  const apps = await runtime.list(ctx);
  const exact = apps.filter(({ name }) => name === ref);
  const matches = exact.length > 0
    ? exact
    : apps.filter(({ name }) => name.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return (matches[0] as AppDocument).id;
  if (matches.length > 1) {
    throw new VendoError(
      "validation",
      `More than one app is called "${ref}": ${matches.map(({ name, id }) => `${name} (${id})`).join(", ")}.`
      + " Ask which one they mean and pass that app's id.",
    );
  }
  return ref;
};
