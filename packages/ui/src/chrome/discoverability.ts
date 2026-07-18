/** Fire-once flags for discoverability elements (ui-usage-dx §6).
 *
 *  Hard rule: every discoverability element renders at most once per user per
 *  deployment, ever — localStorage (origin-scoped, so per-deployment) is the
 *  source of truth, and any degraded environment (SSR, sandboxed iframe,
 *  blocked or full storage) reads as already-seen so it never nags. */

const PREFIX = "vendo:discoverability:";

function storage(): Storage | null {
  try {
    // The ACCESS itself can throw (sandboxed iframes, partitioned storage).
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** True once the element has fired — or whenever storage cannot answer. */
export function hasSeen(element: string): boolean {
  const store = storage();
  if (!store) return true;
  try {
    return store.getItem(PREFIX + element) !== null;
  } catch {
    return true;
  }
}

/** Record the element as fired. Best-effort: a write that fails stays silent
 *  (the matching hasSeen already reports seen in those environments). */
export function markSeen(element: string): void {
  try {
    storage()?.setItem(PREFIX + element, "1");
  } catch {
    /* quota/denied — nothing to do */
  }
}
