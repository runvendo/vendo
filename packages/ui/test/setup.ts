/**
 * Test-realm bridge: vitest's jsdom environment supplies jsdom's
 * `AbortController`, while `fetch` stays Node's undici — which rejects
 * foreign `AbortSignal` instances outright ("Expected signal to be an
 * instance of AbortSignal"). Re-wrap any provided signal into a native
 * one so cross-realm aborts keep working exactly like a browser.
 */
import { transferableAbortController } from "node:util";

const nativeFetch = globalThis.fetch;

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const signal = init?.signal;
  if (!signal) return nativeFetch(input, init);
  const controller = transferableAbortController();
  if (signal.aborted) {
    controller.abort(signal.reason);
  } else {
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return nativeFetch(input, { ...init, signal: controller.signal });
}) as typeof fetch;
