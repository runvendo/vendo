/** F10 (ENG-388) — the overlay's remembered conversation. One id per origin
 *  (localStorage scoping, same rationale as discoverability.ts): the wire is
 *  principal-scoped and useVendoThread self-heals a stale or foreign id to a
 *  fresh thread, so persisting the bare id is safe. Degraded environments
 *  (SSR, sandboxed iframe, blocked or full storage) read as "nothing
 *  remembered" and writes stay silent. */

const KEY = "vendo:last-thread";
const THREAD_ID = /^thr_.+$/;

function storage(): Storage | null {
  try {
    // The ACCESS itself can throw (sandboxed iframes, partitioned storage).
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The remembered conversation id, when one is stored and well formed. */
export function lastThreadId(): string | undefined {
  try {
    const value = storage()?.getItem(KEY);
    return typeof value === "string" && THREAD_ID.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Remember the conversation. Best-effort: a failed write stays silent. */
export function rememberThread(threadId: string): void {
  try {
    storage()?.setItem(KEY, threadId);
  } catch {
    /* quota/denied — nothing to do */
  }
}

/** Forget the remembered conversation (an explicit fresh start). */
export function forgetThread(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* quota/denied — nothing to do */
  }
}
