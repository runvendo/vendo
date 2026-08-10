import type { Json } from "@vendoai/core";

/**
 * A bound action may be CALLED with its own argument object: a Kit control that
 * knows which record it acts on (DataTable/CardList row actions) passes that
 * row's fields at press time, which is the only way a per-row action can reach
 * the tool — an authored payload is fixed for the whole screen.
 *
 * Only a PLAIN object folds in. Kit controls hand their handlers whatever they
 * have: `Form` calls `onSubmit(event)` and `Select` calls `onChange(value)`, and
 * neither a synthetic event nor a bare string may ever become tool arguments.
 * Anything that is not a plain object leaves the payload untouched, so every
 * existing call site behaves exactly as it did.
 *
 * Shared by both action dispatchers — the host renderer and the jail runtime —
 * so a hydrated action means the same thing on either side of the frame.
 */
const isPlainRecord = (value: unknown): value is Record<string, Json> =>
  typeof value === "object"
    && value !== null
    && Object.getPrototypeOf(value) === Object.prototype;

export function mergeActionArgs(payload: Json | undefined, extra: unknown): Json | undefined {
  if (!isPlainRecord(extra)) return payload;
  return isPlainRecord(payload) ? { ...payload, ...extra } : extra;
}
