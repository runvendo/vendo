/** ENG-225 — VendoToasts: the delivery surface for moments that land while the
    user is elsewhere on the page (an automation finishing, an approval parking).
    One fixed stack (.fl-toasts), portaled to <body> so no host stacking context
    can trap it, carrying its own theme boundary like MorphToast.

    Two feeds compose it:
    - `vendoToast(...)` — the imperative host API (module singleton, works from
      any code path; automations delivery wires through this).
    - `approvals` — opt-in polling of pending approvals: a NEWLY parked approval
      raises an approval-required toast, decidable in place. */
import { VENDO_APP_BUILD_TOOL } from "@vendoai/core";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVendoProvider } from "../context.js";
import { useApprovals } from "../hooks/use-approvals.js";
import { themeCssVariables } from "../theme.js";
import { consentAsk, toolPresentation } from "./build-beat.js";
import { NOTE_SEPARATOR } from "./card-shell.js";
import { ensureChromeStyles, useChromeTheme } from "./chrome-root.js";
import { fieldRows } from "./field-rows.js";

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

/**
 * M35 — WCAG 2.2.1 (Timing Adjustable). A toast that carries an ACTION
 * ("Approve", "View") and disappears on a 6s timer is a time limit on an
 * interactive control, and there was no way to stop it: a reader still parsing
 * the sentence, or a switch/keyboard user still travelling to the button, lost
 * both. The countdown is PAUSED while a pointer is over the stack or focus is
 * inside it, and the remainder resumes on the way out — the "pause" mechanism
 * the criterion asks for, on the gesture people already make when they mean
 * "wait". (Sticky toasts, `durationMs: 0`, never had a countdown at all.)
 */
const remaining = new Map<number, number>();
const startedAt = new Map<number, number>();
let paused = false;

function arm(id: number, ms: number): void {
  remaining.set(id, ms);
  if (paused) return;
  startedAt.set(id, Date.now());
  timers.set(id, setTimeout(() => removeToast(id), ms));
}

/** Hold every countdown where it stands. */
function pauseVendoToastTimers(): void {
  if (paused) return;
  paused = true;
  for (const [id, timer] of timers) {
    clearTimeout(timer);
    const left = (remaining.get(id) ?? 0) - (Date.now() - (startedAt.get(id) ?? Date.now()));
    remaining.set(id, Math.max(left, 0));
  }
  timers.clear();
}

/** …and let them run out the rest of their time. */
function resumeVendoToastTimers(): void {
  if (!paused) return;
  paused = false;
  for (const [id, left] of [...remaining]) {
    if (queue.some(toast => toast.id === id)) arm(id, left);
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function removeToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  remaining.delete(id);
  startedAt.delete(id);
  if (queue.some(toast => toast.id === id)) {
    queue = queue.filter(toast => toast.id !== id);
    notify();
  }
}

/** Withdraw every queued toast (host page teardown, tests). */
export function dismissAllVendoToasts(): void {
  for (const toast of [...queue]) removeToast(toast.id);
  paused = false;
}

/** Raise a toast. Returns a dismiss handle. */
export function vendoToast(input: VendoToastInput): () => void {
  const id = nextToastId++;
  queue = [...queue, { ...input, id }];
  const duration = input.durationMs ?? (input.kind === "approval-required" ? 0 : 6_000);
  if (duration > 0) arm(id, duration);
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

/** Opt-in approval feed: a toast per approval waiting on the user, decidable in
    place, withdrawn once decided anywhere.

    IT SHOWS THE BACKLOG TOO. This took the asks present at mount as a baseline
    and toasted only what arrived after — so a standing ask (a build's "spend a
    machine?") stopped being answerable the moment the page reloaded, measured as
    0 cards and 0 Approve buttons against an ask still pending on the wire. The
    spec's whole shape is "the yes, WHENEVER", and an ask that only exists while
    you are watching is not a standing one. Nothing here re-raises what a person
    ANSWERED (`seen`, below, is what a dismissal respects, and a decided ask
    leaves the pending list); what comes back is only what is still unanswered. */
function ApprovalToasts({ pollMs }: { pollMs: number }) {
  const { tools } = useVendoProvider();
  const { pending, decide } = useApprovals({ pollMs });
  const seenRef = useRef(new Set<string>());
  const dismissersRef = useRef(new Map<string, () => void>());
  useEffect(() => {
    const dismissers = dismissersRef.current;
    const seen = seenRef.current;
    for (const approval of pending) {
      // A build's ask is answered on its own in-thread card (ApprovalCard,
      // painted from the `data-vendo-approval` part), so a toast would ask the
      // same question a second time. It still counts in the launcher badge —
      // that is what keeps a closed thread from stranding it.
      if (approval.call.tool === VENDO_APP_BUILD_TOOL) continue;
      if (seen.has(approval.id) || dismissers.has(approval.id)) continue;
      seen.add(approval.id);
      // Ruling 14's ONE plain-words ladder, the same one the approval card and
      // its queue row read — so the toast cannot ask a different question from
      // the card. It used to say the tool's LABEL and nothing else ("Waiting on
      // you: Vendo app build"), which names no ask a person could weigh.
      const meta = tools[approval.call.tool];
      const ask = consentAsk(
        approval.descriptor.risk,
        toolPresentation(
          approval.call.tool,
          approval.call.args,
          meta,
          approval.descriptor.title,
          approval.descriptor.inputSchema,
        ),
        fieldRows(approval.call.args, approval.descriptor.inputSchema, meta),
        meta,
      );
      const settle = (approve: boolean) => () => {
        void decide(approval.id, { approve }).then(() => {
          dismissers.get(approval.id)?.();
          dismissers.delete(approval.id);
        }).catch(() => {
          // The decide failed — the approval is still parked server-side.
          // Keep the toast so the buttons stay retryable, and un-see the id
          // so a later poll can re-raise it once this card is gone.
          seen.delete(approval.id);
        });
      };
      const dismiss = vendoToast({
        kind: "approval-required",
        text: `Waiting on you: ${ask.question}`,
        // THE HONESTY LAW (card-shell.tsx) on the toast too: every real input
        // the question does not already name, then what approving does.
        hint: ask.notes.join(NOTE_SEPARATOR),
        actions: [
          { label: "Approve", primary: true, onAction: settle(true) },
          // The × is a dismissal, not an answer, and a person being asked to
          // spend a machine must be able to say no to it.
          { label: "Deny", onAction: settle(false) },
        ],
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
  }, [pending, decide, tools]);
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
  // Mounted bare (the usual shape) this is the provider theme. Mounted inside a
  // chrome surface that carries its own `theme`, the stack wears that one — it
  // portals out of the DOM subtree, so context is the only way the boundary
  // reaches it.
  const theme = useChromeTheme();
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
          data-vendo-ignore=""
          // H-2 — the toast stack lives ABOVE the modal layer: it portals to
          // <body> with no dialog semantics, so `inertBehind` (overlay panel,
          // mobile takeover) inerted it and every toast raised while one was
          // open — an approval ask with its Approve button included — became
          // unclickable. This marks it as a Vendo surface that is never behind.
          data-vendo-portal="toasts"
          data-vendo-motion={theme.motion}
          data-vendo-density={theme.density}
          style={themeCssVariables(theme) as React.CSSProperties}
        >
          {/* M35 — hovering or tabbing into the stack pauses every countdown
              (WCAG 2.2.1); leaving resumes the remainder. */}
          <div
            className="fl-toasts"
            data-placement={placement}
            role="region"
            aria-label="Notifications"
            onMouseEnter={pauseVendoToastTimers}
            onMouseLeave={resumeVendoToastTimers}
            onFocusCapture={pauseVendoToastTimers}
            onBlurCapture={resumeVendoToastTimers}
          >
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
                  {/* Under the question, not beside the buttons. The hint used
                      to ride the actions ROW, which is a centred flex line, so
                      it read fine at five words ("Runs as you once approved")
                      and folded into a tall column beside Approve the moment it
                      carried a real ask. Its home is the body's own column —
                      the same place the approval card puts the same line. */}
                  {toast.hint !== undefined ? <div className="fl-toasts-hint">{toast.hint}</div> : null}
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
