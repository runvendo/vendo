import { useCallback, useEffect, useRef, useState } from "react";
import { ChromeRoot } from "../chrome/chrome-root.js";
import { useVendoContext } from "../context.js";
import { PayloadView } from "../tree/renderer.js";
import type { VoiceSessionView, VoiceState, VoiceTranscriptEntry } from "./driver.js";
import { useVoiceApprovals } from "./use-voice-approvals.js";
import { useVoice } from "./use-voice.js";
import { VoiceBlob, type VoiceBlobState } from "./voice-blob.js";
import { VoiceConsent } from "./voice-consent.js";
import { VoiceDrawer } from "./voice-drawer.js";

const ACTIVE_STATES = new Set<VoiceState>(["connecting", "reconnecting", "listening", "speaking"]);
const EXIT_BEAT_MS = 520;

const STATUS_COPY: Record<VoiceState, string> = {
  unavailable: "Voice unavailable",
  idle: "Ready for voice",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  listening: "Listening",
  speaking: "Speaking",
  error: "Voice session failed",
};

export interface VendoStageProps {
  /** Called after Stop's settle beat, so a host can unmount the stage cleanly. */
  onSessionEnd?(): void;
}

/** The accessible, theme-adopting voice surface (08-ui §4). */
export function VendoStage({ onSessionEnd }: VendoStageProps) {
  const { client } = useVendoContext();
  const voice = useVoice();
  const active = ACTIVE_STATES.has(voice.state);
  const approvals = useVoiceApprovals(client, active);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const [leaving, setLeaving] = useState(false);
  const [leavingState, setLeavingState] = useState<VoiceState>();
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const pendingApproval = approvals.request;
  useEffect(() => {
    if (!pendingApproval || !drawerOpen) return;
    setDrawerOpen(false);
    queueMicrotask(() => stageRef.current?.querySelector<HTMLButtonElement>(".fl-voice-consent button")?.focus());
  }, [drawerOpen, pendingApproval]);

  useEffect(() => () => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
  }, []);

  const endSession = () => {
    if (leaving) return;
    setLeavingState(voice.state);
    setLeaving(true);
    setDrawerOpen(false);
    voice.stop();
    const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    leaveTimerRef.current = setTimeout(() => {
      setLeaving(false);
      setLeavingState(undefined);
      onSessionEnd?.();
    }, reduce ? 0 : EXIT_BEAT_MS);
  };

  const displayState = leavingState ?? voice.state;
  const blobState = voiceBlobState(displayState, voice.muted);
  const status = displayState === "error" ? voice.error?.message ?? STATUS_COPY.error : STATUS_COPY[displayState];
  const userLine = lastLine(voice.transcript, "user");
  const agentLine = lastLine(voice.transcript, "assistant");

  return (
    <ChromeRoot className="fl-voice-root">
      <section
        ref={stageRef}
        aria-label="Voice session"
        className={`fl-voice-stage is-${displayState}${leaving ? " is-leaving" : ""}`}
        data-state={displayState}
      >
        <div className={`fl-voice-canvas${voice.views.length > 0 ? " has-views" : ""}`}>
          <div className="fl-voice-lift" aria-hidden="true" />
          <div className="fl-voice-head">
            <VoiceBlob
              state={blobState}
              className={displayState === "listening" ? "fl-approval-listening" : undefined}
              amplitude={voice.amplitude}
            />
            <div className="fl-voice-status" role="status" aria-label="Voice status" aria-live="polite">
              {voice.muted && active ? "Muted" : status}
            </div>
            <div className="fl-voice-caption" aria-label="Live captions" aria-live="polite">
              {userLine ? (
                <span className={`is-user${userLine.final ? " is-settled" : ""}`}>{userLine.text}</span>
              ) : null}
              {agentLine ? (
                <span className={`is-agent${agentLine.final ? " is-settled" : ""}`}>{agentLine.text}</span>
              ) : null}
            </div>
          </div>

          <VoiceFeed views={voice.views} />
        </div>

        {displayState === "reconnecting" ? (
          <div className="fl-voice-banner" role="status" aria-live="polite">Reconnecting…</div>
        ) : null}
        {voice.state === "error" && !leaving ? (
          <div className="fl-voice-banner" role="alert">
            <span>{voice.error?.message ?? STATUS_COPY.error}</span>
            <button type="button" className="fl-btn" onClick={voice.start}>Retry</button>
          </div>
        ) : null}

        <VoiceConsent
          request={pendingApproval}
          receipt={approvals.receipt}
          listening={voice.state === "listening"}
          busy={approvals.busyId === pendingApproval?.id}
          error={approvals.error}
          onDecide={(request, approve) => void approvals.decide(request, approve)}
        />

        <VoiceDrawer
          open={drawerOpen}
          transcript={voice.transcript}
          toggleRef={drawerToggleRef}
          onClose={() => setDrawerOpen(false)}
        />

        <div className="fl-voice-foot">
          <button
            ref={drawerToggleRef}
            type="button"
            className="fl-voice-drawer-btn"
            aria-controls="vendo-voice-transcript"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            Transcript
          </button>
          <div className="fl-voice-controls">
            {active && !leaving ? (
              <>
                <button
                  type="button"
                  className={`fl-icon-btn${voice.muted ? " is-active" : ""}`}
                  aria-label={voice.muted ? "Unmute" : "Mute"}
                  aria-pressed={voice.muted}
                  onClick={() => voice.setMuted(!voice.muted)}
                >
                  <MuteIcon muted={voice.muted} />
                </button>
                <button type="button" className="fl-btn" onClick={endSession}>Stop</button>
              </>
            ) : voice.state === "idle" && !leaving ? (
              <button type="button" className="fl-btn fl-btn-primary" onClick={voice.start}>Start voice</button>
            ) : voice.state === "unavailable" && !leaving ? (
              <button type="button" className="fl-btn fl-btn-primary" disabled>Start voice</button>
            ) : null}
          </div>
        </div>
      </section>
    </ChromeRoot>
  );
}

function VoiceFeed({ views }: { views: VoiceSessionView[] }) {
  const { client, components } = useVendoContext();
  const feedRef = useRef<HTMLDivElement>(null);
  const focusFrameRef = useRef<number | undefined>(undefined);
  const followFrameRef = useRef<number | undefined>(undefined);
  const [focusId, setFocusId] = useState<string>();
  const previousCountRef = useRef(0);

  const updateFocus = useCallback(() => {
    const feed = feedRef.current;
    if (!feed) return;
    let closest: { id: string; distance: number } | undefined;
    for (const slide of Array.from(feed.children) as HTMLElement[]) {
      const id = slide.dataset.viewId;
      if (!id) continue;
      const center = slide.offsetTop + slide.offsetHeight / 2 - feed.scrollTop;
      const distance = Math.abs(center - feed.clientHeight / 2);
      if (!closest || distance < closest.distance) closest = { id, distance };
    }
    if (closest) setFocusId(closest.id);
  }, []);

  useEffect(() => {
    if (views.length === 0) {
      setFocusId(undefined);
      previousCountRef.current = 0;
      return;
    }
    if (views.length > previousCountRef.current) {
      const newest = views.at(-1);
      setFocusId(newest?.id);
      if (followFrameRef.current !== undefined && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(followFrameRef.current);
      }
      const follow = () => {
        followFrameRef.current = undefined;
        const target = findSlide(feedRef.current, newest?.id);
        if (typeof target?.scrollIntoView === "function") {
          target.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
        }
      };
      if (typeof requestAnimationFrame === "undefined") follow();
      else followFrameRef.current = requestAnimationFrame(follow);
    }
    previousCountRef.current = views.length;
  }, [views]);

  useEffect(() => () => {
    if (typeof cancelAnimationFrame === "undefined") return;
    if (focusFrameRef.current !== undefined) cancelAnimationFrame(focusFrameRef.current);
    if (followFrameRef.current !== undefined) cancelAnimationFrame(followFrameRef.current);
  }, []);

  const onScroll = () => {
    if (focusFrameRef.current !== undefined) return;
    if (typeof requestAnimationFrame === "undefined") {
      updateFocus();
      return;
    }
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = undefined;
      updateFocus();
    });
  };

  const jumpTo = (view: VoiceSessionView) => {
    setFocusId(view.id);
    const target = findSlide(feedRef.current, view.id);
    if (typeof target?.scrollIntoView === "function") {
      target.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    }
  };

  const focusIndex = views.findIndex((view) => view.id === focusId);
  return (
    <div className="fl-voice-feedwrap">
      <div ref={feedRef} className="fl-voice-feed" aria-label="Session views" onScroll={onScroll}>
        {views.map((view, index) => {
          const position = index === focusIndex
            ? " is-focus"
            : focusIndex >= 0 && index < focusIndex
              ? " is-before"
              : " is-after";
          return (
            <div key={view.id} className={`fl-voice-slide${position}`} data-view-id={view.id}>
              <div className="fl-voice-card">
                <PayloadView
                  payload={view.payload}
                  components={components}
                  onAction={({ action, payload }) => client.apps.call(view.appId, action, payload ?? {})}
                />
              </div>
            </div>
          );
        })}
      </div>
      {views.length > 1 ? (
        <div className="fl-voice-dots" role="group" aria-label="Session view navigation">
          {views.map((view, index) => (
            <button
              key={view.id}
              type="button"
              className={view.id === focusId ? "is-on" : undefined}
              aria-label={`Show view ${index + 1}`}
              aria-pressed={view.id === focusId}
              onClick={() => jumpTo(view)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function lastLine(transcript: VoiceTranscriptEntry[], role: VoiceTranscriptEntry["role"]) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === role) return transcript[index];
  }
  return undefined;
}

function voiceBlobState(state: VoiceState, muted: boolean): VoiceBlobState {
  if (muted && ACTIVE_STATES.has(state)) return "muted";
  if (state === "unavailable" || state === "idle") return "muted";
  return state;
}

function reducedMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function findSlide(feed: HTMLDivElement | null, id: string | undefined): HTMLElement | undefined {
  if (!feed || !id) return undefined;
  return Array.from(feed.children).find((child) => (child as HTMLElement).dataset.viewId === id) as HTMLElement | undefined;
}

function MuteIcon({ muted }: { muted: boolean }) {
  return muted ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="2" y1="2" x2="22" y2="22" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12" /><path d="M15 9.34V5a3 3 0 0 0-5.94-.6" />
      <path d="M5 10v1a7 7 0 0 0 12 5" /><path d="M19 10v1a7 7 0 0 1-.64 2.9" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
    </svg>
  );
}
