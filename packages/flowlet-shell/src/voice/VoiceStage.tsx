import { useEffect, useRef, useState } from "react";
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
export function VoiceStage({ snapshot, onMute, onEnd, onApprove, onDecline, onClosed }: VoiceStageProps) {
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
  const visibleLabel = mutedLive ? "Muted" : status === "connecting" ? STATUS_COPY.connecting : undefined;

  // Feed auto-follows the newest entry (the stage keeps "one thing at a time"
  // attention even though history stays scrollable above).
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, [feed.length]);

  // The exit beat: linger briefly on "ended" so the stage settles instead of
  // vanishing, then hand control back to the thread.
  useEffect(() => {
    if (status !== "ended" || closedFired.current) return;
    closedFired.current = true;
    const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(onClosed, reduce ? 0 : EXIT_BEAT_MS);
    return () => clearTimeout(t);
  }, [status, onClosed]);

  const lastViewIndex = (() => {
    for (let i = feed.length - 1; i >= 0; i--) {
      const entry = feed[i]!;
      if (entry.kind === "view" || entry.kind === "pending-view") return i;
    }
    return -1;
  })();

  const consentAction = pendingApproval ? toolAction(pendingApproval.toolName) : undefined;
  const consentDetail = pendingApproval ? consentFact(pendingApproval.input) : undefined;

  return (
    <div className={`fl-voice-stage is-${status}`} role="dialog" aria-label="Voice session">
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
        <div className="fl-voice-feed" ref={feedRef}>
          {feed.map((entry, index) => {
            if (entry.kind === "pending-view") {
              return (
                <div key={entry.id} className="fl-voice-card is-pending">
                  <div className="fl-generating"><span className="fl-pulse" />Building your view…</div>
                  <Skeleton name={entry.name} />
                </div>
              );
            }
            if (entry.kind === "view") {
              return (
                <div key={entry.id} className={`fl-voice-card ${index === lastViewIndex ? "" : "is-past"}`}>
                  {renderNode(entry.node)}
                </div>
              );
            }
            // Approvals never enter the feed: the agent's UI keeps the stage;
            // consent is edge chrome (the docked bar below).
            return null;
          })}
        </div>
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
