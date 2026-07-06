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
  // (policy deny, capability mismatch, pending-then-denied). Return it RAW so a
  // caller that awaits dispatch()/navigate() sees the failure — swallowing it
  // here would hide policy/nav errors from component code. Fire-and-forget call
  // sites (e.g. Link.onClick) are responsible for catching.
  return Promise.resolve(fn({ action, payload }));
}

/** Navigate the host app. Only same-app paths are meaningful; the host
 *  receiver validates before touching the router. Returns the RAW bridge
 *  Promise — awaiters see a rejection; fire-and-forget callers must catch. */
export function navigate(href: string): Promise<unknown> {
  return dispatch(NAVIGATE_ACTION, { href });
}
