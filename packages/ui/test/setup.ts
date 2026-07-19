/**
 * Test-realm bridge: vitest's jsdom environment supplies jsdom's
 * `AbortController`, while `fetch` stays Node's undici — which rejects
 * foreign `AbortSignal` instances outright ("Expected signal to be an
 * instance of AbortSignal"). Re-wrap any provided signal into a native
 * one so cross-realm aborts keep working exactly like a browser.
 */
import { transferableAbortController } from "node:util";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Raise Testing Library's default async-utility window from 1s to 10s for the
 * whole package. The chrome streaming tests await streamed UI with bare
 * `findBy*` / `waitFor` calls (the retry banner, "Turn complete", a minted
 * thread arriving in the sidebar); under the CI coverage (v8) instrumentation
 * job those settles intermittently exceed the 1s default, surfacing as flaky
 * "Unable to find role=button 'Retry' / 'Fixture thread'" failures on shared
 * runners. Widening the ceiling only adds headroom under load — a query still
 * resolves the moment its element appears, so fast local runs are unaffected.
 */
configure({ asyncUtilTimeout: 10000 });

/**
 * This package's vitest config does not enable `globals`, so
 * @testing-library/react's automatic per-test cleanup (which keys off a global
 * `afterEach`) never registers. Without it, every rendered component stays
 * mounted across the whole file — its effects, listeners, and animation frames
 * outlive the test. Register cleanup explicitly so each test unmounts before the
 * next, matching standard RTL semantics.
 */
afterEach(cleanup);

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
