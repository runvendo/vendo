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

export function dispatch(action: string, payload?: unknown): void {
  const fn = (globalThis as unknown as ShimWindow).__vendoDispatch;
  if (typeof fn === "function") {
    fn({ action, payload });
  } else if (typeof console !== "undefined") {
    console.warn(`[vendo] shim dispatch "${action}" with no bridge — ignored`);
  }
}

/** Navigate the host app. Only same-app paths are meaningful; the host
 *  receiver validates before touching the router. */
export function navigate(href: string): void {
  dispatch(NAVIGATE_ACTION, { href });
}
