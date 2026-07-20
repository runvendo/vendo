/** ENG-225 — VendoToasts: the delivery surface for moments that land while the
    user is elsewhere on the page (an automation finishing, an approval parking).
    One fixed stack (.fl-toasts), portaled to <body> so no host stacking context
    can trap it, carrying its own theme boundary like MorphToast.

    Two feeds compose it:
    - `vendoToast(...)` — the imperative host API (module singleton, works from
      any code path; automations delivery wires through this).
    - `approvals` — opt-in polling of pending approvals: a NEWLY parked approval
      raises an approval-required toast, decidable in place. */
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVendoContext } from "../context.js";
import { useApprovals } from "../hooks/use-approvals.js";
import { themeCssVariables } from "../theme.js";
import { ensureChromeStyles } from "./chrome-root.js";
import { toolTitle } from "./humanize.js";

export interface VendoToastAction {
  label: string;
  onAction(): void;
  /** Primary renders as the filled approve-style button. */
  primary?: boolean;
}

export interface VendoToastInput {
  text: string;
  kind?: "info" | "approval-required";
  state?: "info" | "error";
  hint?: string;
  actions?: VendoToastAction[];
  /** Auto-dismiss after this many ms; 0 keeps the toast until dismissed.
      Defaults to 6000, or sticky for approval-required. */
  durationMs?: number;
}

interface ToastRecord extends VendoToastInput {
  id: number;
}

// Module singleton so `vendoToast` works from any code path, not only under a
// provider. Every mounted <VendoToasts> renders the same queue.
let nextToastId = 1;
let queue: ToastRecord[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function notify(): void {
  for (const listener of listeners) listener();
}

function removeToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  if (queue.some(toast => toast.id === id)) {
    queue = queue.filter(toast => toast.id !== id);
    notify();
  }
}

/** Withdraw every queued toast (host page teardown, tests). */
export function dismissAllVendoToasts(): void {
  for (const toast of [...queue]) removeToast(toast.id);
}

/** Raise a toast. Returns a dismiss handle. */
export function vendoToast(input: VendoToastInput): () => void {
  const id = nextToastId++;
  queue = [...queue, { ...input, id }];
  const duration = input.durationMs ?? (input.kind === "approval-required" ? 0 : 6_000);
  if (duration > 0) timers.set(id, setTimeout(() => removeToast(id), duration));
  notify();
  return () => removeToast(id);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: ToastRecord[] = [];

function useToastQueue(): ToastRecord[] {
  return useSyncExternalStore(subscribe, () => queue, () => EMPTY);
}

/** Opt-in approval feed: raises a toast for every approval that parks AFTER
    mount (the pre-existing backlog belongs to the WaitingQueue, not to a toast
    storm on page load), and withdraws it once decided elsewhere. */
function ApprovalToasts({ pollMs }: { pollMs: number }) {
  const { tools } = useVendoContext();
  const { pending, isLoading, decide } = useApprovals({ pollMs });
  // null until the first fetch settles — that first batch is baseline, not news.
  const seenRef = useRef<Set<string> | null>(null);
  const dismissersRef = useRef(new Map<string, () => void>());
  useEffect(() => {
    const dismissers = dismissersRef.current;
    if (seenRef.current === null) {
      // The hook's initial [] (fetch still in flight) is not the baseline —
      // waiting for it would toast the whole pre-existing backlog on load.
      if (isLoading) return;
      seenRef.current = new Set(pending.map(approval => approval.id));
      return;
    }
    const seen = seenRef.current;
    for (const approval of pending) {
      if (seen.has(approval.id) || dismissers.has(approval.id)) continue;
      seen.add(approval.id);
      const dismiss = vendoToast({
        kind: "approval-required",
        text: `Waiting on you: ${toolTitle(approval.call.tool, tools[approval.call.tool])}`,
        hint: "recorded in Activity",
        actions: [{
          label: "Approve",
          primary: true,
          onAction: () => {
            void decide(approval.id, { approve: true }).then(() => {
              dismissers.get(approval.id)?.();
              dismissers.delete(approval.id);
            }).catch(() => {
              // The decide failed — the approval is still parked server-side.
              // Keep the toast so Approve stays retryable, and un-see the id
              // so a later poll can re-raise it once this card is gone.
              seen.delete(approval.id);
            });
          },
        }],
      });
      dismissers.set(approval.id, dismiss);
    }
    // Decided (or expired) elsewhere: withdraw the stale toast.
    const pendingIds = new Set(pending.map(approval => approval.id));
    for (const [id, dismiss] of dismissers) {
      if (!pendingIds.has(id)) {
        dismiss();
        dismissers.delete(id);
      }
    }
  }, [pending, isLoading, decide, tools]);
  useEffect(() => () => {
    for (const dismiss of dismissersRef.current.values()) dismiss();
    dismissersRef.current.clear();
  }, []);
  return null;
}

export interface VendoToastsProps {
  placement?: "bottom-right" | "bottom-left" | "top-right";
  /** Also surface newly parked approvals as toasts (polls /approvals/pending). */
  approvals?: boolean;
  pollMs?: number;
}

/** 08-ui §4 chrome — mount once per page. */
export function VendoToasts({ placement = "bottom-right", approvals = false, pollMs = 5_000 }: VendoToastsProps = {}): ReactNode {
  const { theme } = useVendoContext();
  const toasts = useToastQueue();
  // The stack portals out of any ChromeRoot subtree, so it owns its own style
  // injection — a page that mounts ONLY VendoToasts still renders styled.
  useEffect(ensureChromeStyles, []);
  if (typeof document === "undefined") return null;
  return (
    <>
      {approvals ? <ApprovalToasts pollMs={pollMs} /> : null}
      {toasts.length > 0 ? createPortal(
        <div
          className="vendo-root"
          data-vendo-motion={theme.motion}
          data-vendo-density={theme.density}
          style={themeCssVariables(theme) as React.CSSProperties}
        >
          <div className="fl-toasts" data-placement={placement} role="region" aria-label="Notifications">
            {toasts.map(toast => (
              <div
                className="fl-toasts-card"
                key={toast.id}
                data-kind={toast.kind ?? "info"}
                data-state={toast.state ?? "info"}
                role="status"
              >
                <span className="fl-toasts-icon" aria-hidden="true">
                  {toast.kind === "approval-required" ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
                    </svg>
                  )}
                </span>
                <div className="fl-toasts-body">
                  <div className="fl-toasts-text">{toast.text}</div>
                  <div className="fl-toasts-actions">
                    {(toast.actions ?? []).map(action => (
                      <button
                        type="button"
                        key={action.label}
                        className={action.primary === true ? "fl-toasts-approve" : "fl-toasts-view"}
                        onClick={action.onAction}
                      >
                        {action.label}
                      </button>
                    ))}
                    {toast.hint !== undefined ? <span className="fl-toasts-hint">{toast.hint}</span> : null}
                    <button type="button" className="fl-toasts-dismiss" aria-label="Dismiss notification" onClick={() => removeToast(toast.id)}>×</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
