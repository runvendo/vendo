/**
 * Bridge access for shims. Inside the sandbox the stage runtime sets
 * `window.__vendoDispatch(descriptor, originNodeId)`; shims call it for the
 * reserved actions they need. Navigation uses the reserved `vendo.navigate`
 * action, which the HOST receiver (SandboxStage) intercepts client-side — it
 * is never sent to the server /action route.
 */
export const NAVIGATE_ACTION = "vendo.navigate";

type Dispatch = (descriptor: { action: string; payload?: unknown }, originNodeId?: string) => unknown;

interface ShimWindow {
  __vendoDispatch?: Dispatch;
}

export function dispatch(action: string, payload?: unknown): Promise<unknown> {
  const fn = (globalThis as unknown as ShimWindow).__vendoDispatch;
  if (typeof fn !== "function") {
    if (typeof console !== "undefined") {
      console.warn(`[vendo] shim dispatch "${action}" with no bridge — ignored`);
    }
    return Promise.resolve(undefined);
  }
  // The runtime bridge returns a Promise that REJECTS on a blocked action
  // (policy deny, capability mismatch). Dropping it left an unhandled rejection
  // and a dead click; own the Promise and swallow-with-log so a blocked action
  // fails quietly instead of crashing.
  return Promise.resolve(fn({ action, payload })).catch((err: unknown) => {
    if (typeof console !== "undefined") {
      console.warn(`[vendo] shim dispatch "${action}" was blocked:`, err);
    }
    return undefined;
  });
}

/** Navigate the host app. Only same-app paths are meaningful; the host
 *  receiver validates before touching the router. Returns the (already
 *  rejection-handled) dispatch Promise so callers never drop it. */
export function navigate(href: string): Promise<unknown> {
  return dispatch(NAVIGATE_ACTION, { href });
}
