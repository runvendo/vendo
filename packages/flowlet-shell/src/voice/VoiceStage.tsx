import { useEffect, useRef, useState } from "react";
import type { UINode } from "@flowlet/core";
import { useShell } from "../context";
import { Skeleton } from "../components/Skeleton";
import { toolAction } from "../components/tool-labels";
import { VoiceBlob } from "./VoiceBlob";
import type { VoiceFeedEntry, VoiceSnapshot } from "./voice-session";
import type { VoiceBlobState } from "./VoiceBlob";

export interface VoiceStageProps {
  snapshot: VoiceSnapshot;
  onMute: (muted: boolean) => void;
  onEnd: () => void;
  onApprove: (id: string, via: "voice" | "tap") => void;
  onDecline: (id: string) => void;
  /** Called after the exit beat once the session has ended — unmount + land
   *  the record in the thread. */
  onClosed: () => void;
  /** Slot-launched (component-activated) sessions: commit the FOCUSED view to
   *  the host card. Offered in the post-call browse state — mid-call, "pin
   *  it" is a spoken request the agent handles. */
  onPin?: (node: UINode) => void;
}

const STATUS_COPY: Record<VoiceSnapshot["status"], string> = {
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  reconnecting: "Voice dropped — reconnecting…",
  error: "Voice couldn't reconnect",
  ended: "Session ended",
};

/** ms the "ended" state lingers before the stage settles back into the thread. */
const EXIT_BEAT_MS = 520;
/** ms a settled consent receipt lingers in the bar before it clears. */
const RECEIPT_MS = 2600;

type ApprovalEntry = Extract<VoiceFeedEntry, { kind: "approval" }>;

/** The one fact worth restating next to a consent question (amount, recipient…). */
function consentFact(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["amount", "channel", "to", "recipient", "recipient_email", "payee"]) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value) return value.length > 48 ? `${value.slice(0, 48)}…` : value;
  }
  return undefined;
}

/**
 * The voice stage (ENG-185, decided 2026-07-02): fills the surface that
 * launched it. The blob is LOCKED at the top with the live caption right under
 * it; the agent's views own the scrolling feed; consent renders as a slim bar
 * docked at the bottom edge (the UI stays the center — Yousef). Ending the
 * session plays a short settle beat, then `onClosed` lands the record in the
 * thread.
 */
export function VoiceStage({ snapshot, onMute, onEnd, onApprove, onDecline, onClosed, onPin }: VoiceStageProps) {
  const { renderNode } = useShell();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const closedFired = useRef(false);

  const { status, muted, amplitude, live, transcript, feed, errorMessage } = snapshot;

  const approvals = feed.filter((entry): entry is ApprovalEntry => entry.kind === "approval");
  const pendingApproval = approvals.find((entry) => !entry.resolution);

  // A settled consent lingers briefly as a receipt in the bar, then clears —
  // the audit copy lives in the transcript/thread, not on the stage.
  const [receipt, setReceipt] = useState<ApprovalEntry | null>(null);
  const resolvedCount = approvals.filter((entry) => entry.resolution).length;
  const prevResolved = useRef(0);
  const receiptTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (resolvedCount > prevResolved.current) {
      const latest = [...approvals].reverse().find((entry) => entry.resolution) ?? null;
      setReceipt(latest);
      clearTimeout(receiptTimer.current);
      receiptTimer.current = setTimeout(() => setReceipt(null), RECEIPT_MS);
    }
    prevResolved.current = resolvedCount;
  }, [resolvedCount, approvals]);
  useEffect(() => () => clearTimeout(receiptTimer.current), []);

  // The floating drawer must never sit between the user and a consent moment:
  // it yields to any newly-arrived pending approval (found live in Playwright —
  // an open drawer intercepted the critical confirm tap).
  useEffect(() => {
    if (pendingApproval) setDrawerOpen(false);
  }, [pendingApproval]);

  const blobState: VoiceBlobState =
    status === "reconnecting" || status === "error"
      ? "error"
      : muted && (status === "listening" || status === "speaking" || status === "thinking")
        ? "muted"
        : status === "ended"
          ? "muted"
          : status;

  // The blob's behavior IS the state (native-voice register). A visible label
  // appears only where motion alone is ambiguous; a live region announces
  // every state for screen readers regardless.
  const mutedLive = muted && (status === "listening" || status === "speaking" || status === "thinking");
  const visibleLabel = mutedLive
    ? "Muted"
    : status === "connecting" || status === "ended"
      ? STATUS_COPY[status]
      : undefined;

  // Feed auto-follows the newest entry, landing its TOP under the blob (the
  // snap resting position) rather than approximately-bottom — the stage keeps
  // "one thing at a time" attention even though history stays scrollable.
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const last = el.lastElementChild;
    if (last && typeof last.scrollIntoView === "function") {
      last.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    } else if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [feed.length]);

  // Ending the call does NOT auto-return to chat (Yousef): the stage stays up
  // with its views browsable; "Back to chat" is an explicit choice. Leaving
  // plays the settle beat, then hands control (and the record) to the thread.
  const [leaving, setLeaving] = useState(false);
  const leave = () => {
    if (closedFired.current) return;
    closedFired.current = true;
    setLeaving(true);
    const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(onClosed, reduce ? 0 : EXIT_BEAT_MS);
  };

  // One view carries the focus (crisp); the others blur until scrolled to.
  // Focus follows the SCROLL position — whichever card rests at the snap line
  // under the blob — not recency, so flicking back re-focuses an older view.
  const [focusId, setFocusId] = useState<string | null>(null);
  const focusFrame = useRef<number | null>(null);
  const updateFocus = () => {
    const el = feedRef.current;
    if (!el) return;
    let best: { id: string; distance: number } | null = null;
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const id = child.dataset.entryId;
      if (!id) continue;
      const distance = Math.abs(child.offsetTop - el.scrollTop - el.offsetTop);
      if (!best || distance < best.distance) best = { id, distance };
    }
    setFocusId(best ? best.id : null);
  };
  const onFeedScroll = () => {
    if (focusFrame.current !== null || typeof requestAnimationFrame === "undefined") return;
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = null;
      updateFocus();
    });
  };
  useEffect(() => () => {
    if (focusFrame.current !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(focusFrame.current);
    }
  }, []);
  // A new entry takes the focus immediately (the auto-follow scroll is still
  // in flight; scroll events refine it as the animation lands).
  useEffect(updateFocus, [feed.length]);

  const consentAction = pendingApproval ? toolAction(pendingApproval.toolName) : undefined;
  const consentDetail = pendingApproval ? consentFact(pendingApproval.input) : undefined;

  const slides = feed.filter((entry) => entry.kind !== "approval");
  const focusedSlide = slides.find((entry) => entry.id === focusId);
  const focusedNode = focusedSlide?.kind === "view" ? focusedSlide.node : undefined;
  const jumpTo = (id: string) => {
    const el = feedRef.current;
    if (!el) return;
    const target = Array.from(el.children).find((child) => (child as HTMLElement).dataset.entryId === id);
    if (target && typeof target.scrollIntoView === "function") {
      const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    }
  };

  return (
    <div
      className={`fl-voice-stage is-${status} ${leaving ? "is-leaving" : ""}`}
      role="dialog"
      aria-label="Voice session"
    >
      {/* The blob never moves: the feed scrolls under this pinned head. */}
      <div className="fl-voice-head">
        <VoiceBlob state={blobState} amplitude={amplitude} size={96} />
        <span className="fl-sr-only" role="status" aria-live="polite">
          {mutedLive ? "Muted" : STATUS_COPY[status]}
        </span>
        {visibleLabel && <div className="fl-voice-status">{visibleLabel}</div>}
        {/* The conversation lives with the blob (Yousef): the current utterance
            streams right under the presence, not in a far-away footer strip. */}
        <div className="fl-voice-caption" aria-live="off">
          {live && (
            <span className={live.role === "user" ? "is-user" : "is-agent"}>
              {live.text}
              {live.interrupted && <em> — interrupted</em>}
            </span>
          )}
        </div>
      </div>

      <div className="fl-voice-feedwrap">
        <div className="fl-voice-feed" ref={feedRef} onScroll={onFeedScroll}>
          {/* Each view is a SLIDE — it owns the stage while focused; scroll
              pages between slides (mandatory snap). Approvals never enter the
              feed: consent is edge chrome (the docked bar below). */}
          {slides.map((entry) => (
            <div
              key={entry.id}
              data-entry-id={entry.id}
              className={`fl-voice-slide ${entry.id === focusId ? "is-focus" : ""} ${entry.kind === "pending-view" ? "is-pending" : ""}`}
            >
              <div className="fl-voice-card">
                {entry.kind === "pending-view" ? (
                  <>
                    <div className="fl-generating"><span className="fl-pulse" />Building your view…</div>
                    <Skeleton name={entry.name} />
                  </>
                ) : (
                  renderNode(entry.node)
                )}
              </div>
            </div>
          ))}
        </div>
        {slides.length > 1 && (
          <div className="fl-voice-dots" role="tablist" aria-label="Views in this session">
            {slides.map((entry, i) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={entry.id === focusId}
                aria-label={`View ${i + 1} of ${slides.length}`}
                className={entry.id === focusId ? "is-on" : ""}
                onClick={() => jumpTo(entry.id)}
              />
            ))}
          </div>
        )}
      </div>

      {(status === "reconnecting" || status === "error") && (
        <div className="fl-voice-banner" role="alert">
          <span>
            {status === "reconnecting"
              ? errorMessage ?? "Voice dropped — reconnecting…"
              : errorMessage ?? "Voice couldn't reconnect. Your conversation is saved."}
          </span>
          {status === "error" && (
            <button type="button" className="fl-error-retry" onClick={onEnd}>
              Continue by typing
            </button>
          )}
        </div>
      )}

      {/* Consent: a slim bar docked at the edge — act tier listens for a spoken
          yes (and stays tappable); critical demands the named tap. A settled
          decision lingers as a receipt, then clears. */}
      {pendingApproval && consentAction ? (
        <div
          className={`fl-voice-consent ${pendingApproval.tier === "critical" ? "is-critical" : "is-listening"}`}
          role="group"
          aria-label={`Approval request: ${consentAction.request}`}
        >
          <span className="fl-voice-consent-ic" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
            </svg>
          </span>
          <div className="fl-voice-consent-copy">
            <span className="fl-voice-consent-title">
              {consentAction.request}
              {consentDetail ? <span className="fl-voice-consent-fact"> — {consentDetail}</span> : null}
            </span>
            {pendingApproval.tier === "critical" && (
              <span className="fl-voice-consent-warn">This can't be undone.</span>
            )}
          </div>
          <div className="fl-voice-consent-actions">
            <button
              type="button"
              className={`fl-btn fl-btn-primary ${pendingApproval.tier === "critical" ? "fl-btn-critical" : ""}`}
              onClick={() => onApprove(pendingApproval.id, "tap")}
            >
              {pendingApproval.tier === "critical" ? `Confirm — ${consentAction.request.toLowerCase()}` : "Allow"}
            </button>
            <button type="button" className="fl-btn" onClick={() => onDecline(pendingApproval.id)}>
              Decline
            </button>
          </div>
        </div>
      ) : receipt?.resolution ? (
        <div
          className={`fl-voice-consent is-receipt ${receipt.resolution === "declined" ? "is-declined" : ""}`}
          role="status"
        >
          {receipt.resolution === "declined"
            ? `${toolAction(receipt.toolName).request} — declined`
            : `${toolAction(receipt.toolName).done} — approved ${receipt.resolution === "voice" ? "by voice" : "on screen"} ✓`}
        </div>
      ) : null}

      <div className="fl-voice-foot">
        <button
          type="button"
          className="fl-voice-drawer-btn"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((open) => !open)}
        >
          {drawerOpen ? "⌄" : "⌃"} transcript
        </button>
        <div className="fl-voice-controls">
          {status === "ended" ? (
            // The call is over but the stage stays browsable — leaving is the
            // user's explicit choice, and it lands the record in the thread.
            <>
              {onPin && focusedNode && (
                <button type="button" className="fl-btn" onClick={() => onPin(focusedNode)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                    style={{ marginRight: 6, verticalAlign: -2 }}>
                    <path d="M12 17v5" /><path d="M5 17h14l-1.5-4.5a2 2 0 0 1 0-1.3L19 7H5l1.5 4.2a2 2 0 0 1 0 1.3Z" />
                  </svg>
                  Pin this view
                </button>
              )}
              <button type="button" className="fl-btn fl-btn-primary" onClick={leave}>
                Back to chat
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`fl-icon-btn ${muted ? "is-active" : ""}`}
                aria-label={muted ? "Unmute" : "Mute"}
                aria-pressed={muted}
                onClick={() => onMute(!muted)}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {muted && <line x1="2" y1="2" x2="22" y2="22" />}
                  <rect x="9" y="2" width="6" height="12" rx="3" />
                  <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              </button>
              <button type="button" className="fl-icon-btn" aria-label="End voice session" onClick={onEnd}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>

      {drawerOpen && (
        <div className="fl-voice-drawer">
          {transcript.length === 0 && <div className="fl-voice-drawer-empty">Nothing said yet</div>}
          {transcript.map((line) => (
            <div key={line.id} className={`fl-voice-line ${line.role === "user" ? "is-user" : "is-agent"}`}>
              <span className="fl-voice-line-role">{line.role === "user" ? "You" : "Agent"}</span>
              <span>
                {line.text}
                {line.interrupted && <em> — interrupted</em>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
