/**
 * Internal: CORE-11 — 01 §15 forward-compat. The contract's additive families
 * (error codes, trigger kinds, run models) must TOLERATE unknown variants:
 * new members arrive within the version train and consumers treat what they
 * don't recognize generically. These helpers open the zod schemas without
 * widening the TypeScript unions — known variants keep strict shapes and
 * exhaustive narrowing; an unknown variant parses and reads as the family's
 * generic case at runtime.
 */
import { z } from "zod";

/** An enum field on an additive family: known values plus any non-empty string. */
export function openEnum<Value extends string>(
  values: readonly [Value, ...Value[]],
): z.ZodType<Value> {
  return z.enum([...values] as [Value, ...Value[]])
    .or(z.string().min(1)) as unknown as z.ZodType<Value>;
}

/** The open tail of a kind-discriminated additive union: any object with an
 *  unknown non-empty string `kind`. Known kinds are EXCLUDED so a malformed
 *  known variant still fails its declared shape instead of falling through. */
export function openKindVariant(knownKinds: readonly string[]): z.ZodType<never> {
  return z.object({ kind: z.string().min(1) }).passthrough()
    .refine((value) => !knownKinds.includes(value.kind), {
      message: "known kinds must match their declared shape",
    }) as unknown as z.ZodType<never>;
}
