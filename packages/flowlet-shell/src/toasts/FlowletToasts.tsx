import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useShell } from "../context";
import { useFlowletThread } from "../use-flowlet-thread";
import type { AutomationNotice } from "../seams/notifications";
import { createToastQueue, toastKey, type Toast } from "./toast-queue";

/** Any surface may summon the shared overlay (toast click-through). */
export const OPEN_OVERLAY_EVENT = "flowlet:open-overlay";

export interface FlowletToastsProps {
  /** Corner the stack lives in. */
  placement?: "bottom-right" | "bottom-left" | "top-right";
  /** Deliveries poll cadence (ms). */
  pollMs?: number;
  /** Auto-dismiss window for non-persistent toasts (ms). */
  dismissMs?: number;
  /** Cursor storage namespace (defaults to the shared "flowlet"). */
  namespace?: string;
}

const cursorKey = (namespace: string) => `flowlet:toasts-cursor:${namespace}`;

/** Stable SSR snapshot — a fresh array per call would loop useSyncExternalStore. */
const NO_TOASTS: Toast[] = [];

function readCursor(namespace: string): number | null {
  try {
    const raw = localStorage.getItem(cursorKey(namespace));
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

function writeCursor(namespace: string, cursor: number): void {
  try {
    localStorage.setItem(cursorKey(namespace), String(cursor));
  } catch {
    /* private mode: cursor resets each load; worst case is a repeat digest */
  }
}

/**
 * FlowletToasts (2026-07-04 spec): the in-app Channels surface. Polls the
 * notifications seam, shows automation completions and approvals as corner
 * toasts under the queue policy (max 2, suppressed mid-conversation,
 * approvals persist). First-ever mount baselines silently; later mounts
 * collapse a backlog of completions into one "while you were away" digest.
 */
export function FlowletToasts({
  placement = "bottom-right",
  pollMs = 5000,
  dismissMs = 8000,
  namespace = "flowlet",
}: FlowletToastsProps) {
  const { notifications } = useShell();
  const chat = useFlowletThread();
  const queue = useMemo(createToastQueue, []);
  const toasts = useSyncExternalStore(queue.subscribe, queue.visible, () => NO_TOASTS);

  // Spec: never toast while the user is mid-conversation on any surface.
  const active = chat.status === "submitted" || chat.status === "streaming";
  useEffect(() => queue.setSuppressed(active), [queue, active]);

  // Poll the deliveries feed. The FIRST batch after mount is special: with no
  // stored cursor it only baselines (history must not spam a fresh install);
  // with one, a backlog of completions collapses into a single digest while
  // approvals always surface individually.
  const firstBatch = useRef(true);
  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      const cursor = readCursor(namespace);
      try {
        const notices = await notifications.listSince(cursor ?? 0);
        if (disposed) return;
        const initial = firstBatch.current;
        firstBatch.current = false;
        if (notices.length === 0) {
          // An empty feed still consumes the baseline: without stamping the
          // cursor here, the next delivery would be swallowed as "history".
          if (cursor === null) writeCursor(namespace, 0);
          return;
        }
        writeCursor(namespace, Math.max(...notices.map((n) => n.cursor)));
        if (initial && cursor === null) return; // baseline only
        const push = (notice: AutomationNotice) =>
          queue.push({
            kind: notice.kind,
            runId: notice.runId,
            ...(notice.stepId !== undefined ? { stepId: notice.stepId } : {}),
            summary: notice.summary,
            text: notice.text,
          });
        const approvals = notices.filter((n) => n.kind === "approval-required");
        const completions = notices.filter((n) => n.kind === "completed");
        if (initial && completions.length > 1) {
          queue.push({
            kind: "digest",
            summary: `${completions.length} automations ran`,
            text: `While you were away: ${completions.length} automations ran.`,
          });
        } else {
          completions.forEach(push);
        }
        approvals.forEach(push);
      } catch (err) {
        console.warn("[flowlet] deliveries poll failed", err);
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), pollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [notifications, queue, pollMs, namespace]);

  // Auto-dismiss: each visible non-persistent toast gets one countdown.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const running = timers.current;
    for (const toast of toasts) {
      if (toast.persistent || running.has(toast.key)) continue;
      running.set(
        toast.key,
        setTimeout(() => {
          running.delete(toast.key);
          queue.dismiss(toast.key);
        }, dismissMs),
      );
    }
    return () => {
      // Component teardown only — a re-render must not reset countdowns.
    };
  }, [toasts, queue, dismissMs]);
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );

  const approve = (toast: Toast) => {
    queue.setState(toast.key, "approving");
    notifications
      .resume(toast.runId ?? "", true)
      .then((outcome) => {
        if (outcome === "resumed") queue.dismiss(toast.key);
        else queue.setState(toast.key, "stale");
      })
      .catch(() => queue.setState(toast.key, "error"));
  };

  const view = (toast: Toast) => {
    window.dispatchEvent(new CustomEvent(OPEN_OVERLAY_EVENT));
    queue.dismiss(toast.key);
  };

  if (toasts.length === 0) return null;
  return (
    <div className="fl-toasts" data-placement={placement}>
      {toasts.map((toast) => (
        <div
          key={toast.key}
          className="fl-toasts-card"
          data-kind={toast.kind}
          data-state={toast.state}
          role="status"
        >
          <span className="fl-toasts-icon" aria-hidden="true">
            {toast.kind === "approval-required" ? "⚠" : "✦"}
          </span>
          <div className="fl-toasts-body">
            <span className="fl-toasts-text">
              {toast.state === "stale"
                ? "This approval is no longer waiting."
                : toast.state === "error"
                  ? "That didn't go through — open the assistant for details."
                  : toast.text}
            </span>
            <div className="fl-toasts-actions">
              {toast.kind === "approval-required" && toast.state === "fresh" && (
                <button type="button" className="fl-toasts-approve" onClick={() => approve(toast)}>
                  Approve
                </button>
              )}
              {toast.state === "approving" && <span className="fl-toasts-hint">Approving…</span>}
              <button type="button" className="fl-toasts-view" onClick={() => view(toast)}>
                View
              </button>
              <button
                type="button"
                className="fl-toasts-dismiss"
                aria-label="Dismiss"
                onClick={() => queue.dismiss(toast.key)}
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
