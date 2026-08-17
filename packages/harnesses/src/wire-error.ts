import { log, isVendoError, formatMeterExhausted, meterExhaustedFromError } from "@vendoai/core";

/** The one gate raw errors pass on their way to the wire. Vendo's OWN errors
 *  (code + operator-crafted message) are safe and actionable, so they travel
 *  recognizably prefixed — the thread UI renders the detail line only for
 *  this shape. Anything else (provider/transport internals can carry request
 *  URLs, keys, prompts) stays the fixed generic string. Either way the REAL
 *  error lands in the server log: the operator's terminal is where the
 *  honest message belongs (field case: a dead apps-create turn surfaced as
 *  nothing but "Something went wrong" anywhere).
 *
 *  Its own module so the harness runtime raises the IDENTICAL failure
 *  affordance — banner, Retry, detail line, meter sentence — instead of
 *  inventing a second error UX.
 */
export function wireErrorMessage(error: unknown): string {
  log({
    code: "harnesses.turn-stream-error",
    level: "error",
    message: "[vendo] turn stream error:",
    data: { error },
  });
  return specificWireErrorMessage(error) ?? GENERIC_TURN_ERROR;
}

/** The fixed sentence for a failure with nothing safe to repeat. */
const GENERIC_TURN_ERROR = "An error occurred while generating the response.";

/** The half of {@link wireErrorMessage} that can NAME the failure, split out so
 *  a caller with its own fallback sentence can still tell the two apart —
 *  the runtime's, for a harness that threw rather than reported. Logs nothing;
 *  the caller that has the raw error owns the operator's line. */
export function specificWireErrorMessage(error: unknown): string | undefined {
  // `isVendoError`, not `instanceof`: a host bundle can carry a second
  // @vendoai/core copy (dual-package hazard), and its VendoErrors are just as
  // safe — same crafted messages, same code enum.
  if (isVendoError(error)) return `Vendo: ${error.message} (${error.code})`;
  // Pricing v3 (spec §5): the Cloud model gateway's meter refusal reaches this
  // gate as a provider APICallError (statusCode 402, the structured refusal as
  // its response body), never as a VendoError. Only OUR formatter's sentence —
  // meter, figures, reset date, the two exits, all from the parsed structured
  // fields — travels; the raw body/provider internals still never do, so the
  // ENG-214 policy holds. The refusal body is the only source of truth (no
  // client-side entitlement checks); any other 402 stays the generic string.
  const refusal = meterExhaustedFromError(error);
  if (refusal !== undefined) {
    return `Vendo: ${formatMeterExhausted(refusal)} (cloud-required)`;
  }
  // A rejected key (401) is deliberately NOT classified here: this gate sees
  // every failure a turn can throw — a connector's descriptors() included — and
  // an ai-SDK error shape proves the SHAPE, never the ORIGIN, so a tool's 401
  // would get told to re-mint a model key. The credential ladder is the only
  // place that knows the call was the model's, and it wraps its own 401s with
  // its rung's fix (vendo's dev-creds/model); those arrive above as VendoErrors.
  return undefined;
}
