/**
 * What the launcher pill says while the user is somewhere else.
 *
 * Closing the panel is leaving, not stopping. So the pill has three jobs
 * beyond opening the panel: narrate a run that is still going (humanized beat
 * label + ring), announce the finished result once (a toast whose View returns
 * to the conversation — the thread IS the record), and carry the two standing
 * signals: a numbered badge for asks waiting on the user, a quiet dot for
 * results they haven't seen. Nothing here ever opens or folds a surface on its
 * own; every path needs a click.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { useVendoProvider } from "../context.js";
import { useAttention } from "../hooks/use-approvals.js";
import { toolTitle } from "./humanize.js";
import {
  IDLE_RUN_ACTIVITY,
  markRunResultsSeen,
  runActivity,
  subscribeRunActivity,
  unseenRunResult,
  type RunResult,
} from "./run-activity.js";

/** How long an unacknowledged completion toast stays before it withdraws
    (§3 — "an ignored toast withdraws"; the quiet dot survives it). */
const TOAST_MS = 6_000;

/** Ask-count cadence, matching the toast feed so the badge and the toasts can
    never be a poll apart. */
const ASK_POLL_MS = 5_000;

export interface LauncherStatus {
  /** A run is live and the panel is closed — the pill is the progress. */
  working: boolean;
  /** Humanized label of the live step ("Working" between steps). */
  label: string;
  /** Determinate ring input; absent = the quiet indeterminate ring. */
  progress?: { done: number; total: number };
  /** Asks waiting on the user (the numbered badge). */
  askCount: number;
  /** A finished run the user hasn't looked at (the quiet dot). */
  unseenResults: boolean;
  /** The completion toast currently showing, if any. */
  toast?: RunResult;
  /** View → mark seen and open the panel to the record. */
  view(): void;
  dismissToast(): void;
}

const NO_RESULT = (): RunResult | undefined => undefined;

/**
 * The pill's state. `threadId` is the conversation the panel currently holds
 * (reported by the thread): a result belonging to some OTHER surface's thread
 * is not this launcher's to announce.
 */
export function useLauncherStatus({ open, threadId, onOpen }: {
  open: boolean;
  threadId?: string;
  onOpen(): void;
}): LauncherStatus {
  const { tools } = useVendoProvider();
  const activity = useSyncExternalStore(subscribeRunActivity, runActivity, () => IDLE_RUN_ACTIVITY);
  const result = useSyncExternalStore(subscribeRunActivity, unseenRunResult, NO_RESULT);
  const { askCount } = useAttention({ pollMs: ASK_POLL_MS });
  const [toast, setToast] = useState<RunResult>();

  // While the panel is open, results are seen as they land — the user is
  // looking at the conversation they landed in.
  useEffect(() => {
    if (!open) return;
    markRunResultsSeen();
    setToast(undefined);
  }, [open, result]);

  // One toast per finished run, and only for a run this panel can show.
  const announcedRef = useRef(0);
  useEffect(() => {
    if (open || result === undefined || result.id === announcedRef.current) return;
    if (threadId !== undefined && result.threadId !== undefined && result.threadId !== threadId) return;
    announcedRef.current = result.id;
    setToast(result);
  }, [open, result, threadId]);

  // …which withdraws on its own if it is ignored.
  useEffect(() => {
    if (toast === undefined) return;
    const timer = window.setTimeout(() => setToast(undefined), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const working = activity.running && !open;
  return {
    working,
    label: activity.tool === undefined ? "Working" : toolTitle(activity.tool, tools[activity.tool]),
    // Determinate only when the turn has actually begun more than one step —
    // an honest count, never a guess at what it will do next. A single
    // open-ended step gets the quiet indeterminate ring instead of a fake bar.
    ...(activity.total > 1 ? { progress: { done: activity.done, total: activity.total } } : {}),
    askCount,
    unseenResults: !open && result !== undefined,
    ...(!open && toast !== undefined ? { toast } : {}),
    view() {
      setToast(undefined);
      markRunResultsSeen();
      onOpen();
    },
    dismissToast() {
      setToast(undefined);
    },
  };
}

/** The pill's mark while a run is live: a ring in place of the morph blob. */
function LauncherRing({ progress }: { progress?: { done: number; total: number } }) {
  if (progress === undefined) {
    return <span className="fl-launcher-ring" data-vendo-ring="indeterminate" aria-hidden="true" />;
  }
  const fraction = progress.total > 0 ? progress.done / progress.total : 0;
  return (
    <span
      className="fl-launcher-ring"
      data-vendo-ring="determinate"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={progress.done}
      style={{ "--fl-ring": `${Math.round(fraction * 100)}%` } as CSSProperties}
    />
  );
}

/** dot ≺ number (§3): a waiting ask always outranks an unseen result. */
function LauncherSignal({ askCount, unseenResults }: { askCount: number; unseenResults: boolean }) {
  if (askCount > 0) {
    return <span className="fl-launcher-badge" aria-hidden="true">{askCount > 9 ? "9+" : askCount}</span>;
  }
  return unseenResults ? <span className="fl-launcher-dot" aria-hidden="true" /> : null;
}

/**
 * Everything inside the pill: the mark (morph blob, host icon, or the run's
 * ring), the text (host label, or the live beat), the signal, and the spoken
 * line. The button itself — placement, open/close, focus — stays in
 * VendoOverlay; only its face lives here.
 */
export function LauncherFace({ status, label, icon }: {
  status: LauncherStatus;
  /** The host's pill text; `null` is the blob-only orb (no text at all). */
  label: string | null;
  icon?: ReactNode;
}) {
  const spoken = status.working
    ? `${status.label}…`
    : status.askCount > 0
      ? `${status.askCount} waiting on you`
      : status.unseenResults ? "New results in your conversation" : "";
  return (
    <>
      {status.working
        ? <LauncherRing {...(status.progress === undefined ? {} : { progress: status.progress })} />
        : icon ?? <span className="fl-launcher-blob" aria-hidden="true" />}
      {label === null ? null : status.working
        ? <span className="fl-launcher-beat" aria-hidden="true">{status.label}&hellip;</span>
        : label}
      <LauncherSignal askCount={status.askCount} unseenResults={status.unseenResults} />
      {/* The spoken half, for someone who cannot see the pill. It lives inside
          the button — whose aria-label owns the NAME — so a host page never
          grows an extra landmark for it. */}
      <span className="fl-sr-only" aria-live="polite">{spoken}</span>
    </>
  );
}

/** The completion toast: one headline, one way back. Rides above the pill it
    came from, so the answer lands where the user was already looking. */
export function LauncherToast({ result, position, onView, onDismiss }: {
  result: RunResult;
  position: "bottom-right" | "bottom-left";
  onView(): void;
  onDismiss(): void;
}) {
  return (
    <div className="fl-launcher-toast" data-vendo-launcher={position} aria-live="polite">
      <span className="fl-launcher-toast-head">{result.headline}</span>
      <span className="fl-launcher-toast-actions">
        <button type="button" className="fl-btn fl-btn-primary" onClick={onView}>View</button>
        <button type="button" className="fl-launcher-toast-x" aria-label="Dismiss result" onClick={onDismiss}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </span>
    </div>
  );
}
