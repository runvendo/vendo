import type { ZodType } from "zod";
import { canonicalJson } from "../jcs.js";

/**
 * The assertion vocabulary every conformance kit in this directory throws with.
 *
 * NOT re-exported from `./index.js`: `@vendoai/core/conformance`'s export
 * inventory is the kit surface an adapter author consumes, and these are how the
 * kits are written, not part of what they promise. Importing them from
 * `./index.js` would also make every kit a value-cycle with the barrel that
 * re-exports it.
 */

export const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

export const assertParses = <T>(schema: ZodType<T>, value: unknown, message: string): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${message}: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data;
};

/** Canonical (key-order-insensitive) equality: Postgres jsonb normalizes object
 *  key order, so a byte-for-byte JSON.stringify comparison would fail every
 *  jsonb-backed implementation on a semantically identical value. `undefined` is
 *  not JSON, so it maps to a sentinel — a null/undefined mismatch then fails with
 *  THIS message rather than canonicalJson's refusal. */
export const assertDeepEqual = (actual: unknown, expected: unknown, message: string): void => {
  const canon = (value: unknown): string => (value === undefined ? "undefined" : canonicalJson(value));
  const a = canon(actual);
  const b = canon(expected);
  assert(a === b, `${message}: ${a} !== ${b}`);
};

export const assertBytesEqual = (actual: Uint8Array, expected: Uint8Array, message: string): void => {
  assert(actual.length === expected.length, `${message}: byte lengths differ`);
  for (let index = 0; index < actual.length; index += 1) {
    assert(actual[index] === expected[index], `${message}: byte ${index} differs`);
  }
};
