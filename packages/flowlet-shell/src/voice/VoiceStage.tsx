import { useEffect, useRef, useState } from "react";
import { useShell } from "../context";
import { ApprovalCard } from "../components/ApprovalCard";
import { Skeleton } from "../components/Skeleton";
import { VoiceBlob } from "./VoiceBlob";
import type { VoiceSnapshot } from "./voice-session";
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

/**
 * The voice stage (ENG-185, decided 2026-07-02): fills the surface that
 * launched it. The blob is LOCKED at the top; views and approval cards stack
 * into a scrolling feed beneath it; the live caption sits above the footer;
 * the transcript rides in a peek drawer. Ending the session plays a short
 * settle beat, then `onClosed` lands the record in the thread.
 */
export function VoiceStage({ snapshot, onMute, onEnd, onApprove, onDecline, onClosed }: VoiceStageProps) {
  const { renderNode } = useShell();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const closedFired = useRef(false);

  const { status, muted, amplitude, live, transcript, feed, errorMessage } = snapshot;

  // The floating drawer must never sit between the user and a consent moment:
  // it yields to any newly-arrived pending approval (found live in Playwright —
  // an open drawer intercepted the critical confirm tap).
  const pendingApprovals = feed.filter((entry) => entry.kind === "approval" && !entry.resolution).length;
  useEffect(() => {
    if (pendingApprovals > 0) setDrawerOpen(false);
  }, [pendingApprovals]);

  const blobState: VoiceBlobState =
    status === "reconnecting" || status === "error"
      ? "error"
      : muted && (status === "listening" || status === "speaking" || status === "thinking")
        ? "muted"
        : status === "ended"
          ? "muted"
          : status;

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

  return (
    <div className={`fl-voice-stage is-${status}`} role="dialog" aria-label="Voice session">
      {/* The blob never moves: the feed scrolls under this pinned head. */}
      <div className="fl-voice-head">
        <VoiceBlob state={blobState} amplitude={amplitude} size={96} />
        <div className="fl-voice-status" aria-live="polite">
          {muted && (status === "listening" || status === "speaking" || status === "thinking")
            ? "Muted"
            : STATUS_COPY[status]}
        </div>
      </div>

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
          return (
            <div key={entry.id} className="fl-voice-card fl-voice-approval">
              <ApprovalCard
                toolName={entry.toolName}
                input={entry.input}
                tier={entry.tier}
                listening={entry.tier === "act"}
                resolution={entry.resolution}
                consequence={entry.tier === "critical" ? "This can't be undone." : undefined}
                onApprove={() => onApprove(entry.id, "tap")}
                onDecline={() => onDecline(entry.id)}
              />
            </div>
          );
        })}
      </div>

      {/* Live caption — the current utterance/narration, word by word. */}
      <div className="fl-voice-caption" aria-live="off">
        {live && (
          <span className={live.role === "user" ? "is-user" : "is-agent"}>
            {live.text}
            {live.interrupted && <em> — interrupted</em>}
          </span>
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
