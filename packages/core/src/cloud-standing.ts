import { VendoError } from "./errors.js";
import { formatMeterExhausted, meterExhaustedDetail, parseMeterExhausted } from "./meter-exhausted.js";

/**
 * The two "fix your Cloud standing" refusals every Vendo Cloud door sends —
 * 401 (missing/revoked key) and 402 (dry meter) — read ONE way by every Cloud
 * client: `cloud-required`, carrying the CONSOLE's own message, and for a meter
 * refusal the crafted sentence plus the structured fields on `detail`.
 * `undefined` for any other status, so the caller keeps its own mapping.
 *
 * This is the CONSOLE's reading. `parseStoreWireError` is deliberately NOT
 * routed through here: a BYO wire mount is not Vendo Cloud.
 */
export function cloudStandingError(
  status: number,
  payload: unknown,
  fallbackMessage: string,
): VendoError | undefined {
  if (status !== 401 && status !== 402) return undefined;
  const refusal = parseMeterExhausted(payload);
  if (refusal !== undefined) {
    return new VendoError("cloud-required", formatMeterExhausted(refusal), meterExhaustedDetail(refusal));
  }
  const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
  return new VendoError("cloud-required", typeof message === "string" ? message : fallbackMessage);
}
