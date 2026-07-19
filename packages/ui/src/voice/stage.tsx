import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ChromeRoot } from "../chrome/chrome-root.js";
import { ConnectCard } from "../chrome/connect-card.js";
import { useVendoContext } from "../context.js";
import { PayloadView } from "../tree/renderer.js";
import type { VoiceSessionView, VoiceState } from "./driver.js";
import { useVoiceApprovals } from "./use-voice-approvals.js";
import { useVoice } from "./use-voice.js";
import { VoiceBlob, type VoiceBlobState } from "./voice-blob.js";
import { VoiceConsent, isAutomation } from "./voice-consent.js";
import { VoiceDrawer } from "./voice-drawer.js";

const ACTIVE_STATES = new Set<VoiceState>(["connecting", "reconnecting", "listening", "speaking"]);
const EXIT_BEAT_MS = 520;
/** Voice-lane composite — the docked presence pill's ball diameter (P-C). */
const DOCKED_BALL_SIZE = 30;
const STAGE_BALL_SIZE = 96;
/** The lift morph animates grid rows for .55s; feed centering re-runs after. */
const LIFT_SETTLE_MS = 620;

const STATUS_COPY: Record<VoiceState, string> = {
  unavailable: "Voice unavailable",
  idle: "Ready for voice",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  listening: "Listening",
  speaking: "Speaking",
  error: "Voice session failed",
};

/** fluidkit MorphSurface's BODY_SPRING (stiffness 240, damping 24) sampled to a
    CSS linear() easing — the dock morph rides the library's own curve. */
function springLinear(stiffness = 240, damping = 24, mass = 1, dur = 0.62): string {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const wd = w0 * Math.sqrt(Math.max(1e-6, 1 - zeta * zeta));
  const pts: string[] = [];
  for (let i = 0; i <= 60; i += 1) {
    const t = dur * (i / 60);
    const x = 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
    pts.push(x.toFixed(4));
  }
  return `linear(${pts.join(",")})`;
}
const DOCK_SPRING = springLinear();
const DOCK_SPRING_MS = 620;

function reducedMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface VendoStageProps {
  /** Called after Stop's settle beat, so a host can unmount the stage cleanly. */
  onSessionEnd?(): void;
  /** Idle-invitation chips (S-E). Rendered only while idle; a tap starts voice. */
  suggestions?: string[];
}

/** The accessible, theme-adopting voice surface (08-ui §4), carrying the
    voice-lane composite: PiP dock (P-C), speaker lean (P-F), rolling ticker
    captions (S-C), idle invitation (S-E), attention vignette (S-F), spoken-yes
    consent (C-A) and the connect-during-voice slot (Cn-A). */
export function VendoStage({ onSessionEnd, suggestions }: VendoStageProps) {
  const { client } = useVendoContext();
  const voice = useVoice();
  const active = ACTIVE_STATES.has(voice.state);
  const approvals = useVoiceApprovals(client, active);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
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

  // C-A spoken-yes: a recognized "approve"/"decline" decides the act-tier bar —
  // but ONLY the request that was already on screen when the words were spoken.
  // The refs pin that request: an intent with no matching request is discarded
  // (never carried forward to a later approval), criticals stay hand-only, and
  // automation requests (rich card, no spoken affordance) are never voice-decided.
  const decide = approvals.decide;
  const { clearIntent } = voice;
  const pendingApprovalRef = useRef(pendingApproval);
  pendingApprovalRef.current = pendingApproval;
  const voiceStateRef = useRef(voice.state);
  voiceStateRef.current = voice.state;
  useEffect(() => {
    const intent = voice.intent;
    if (!intent) return;
    const request = pendingApprovalRef.current;
    if (request && voiceStateRef.current === "listening") {
      const critical = request.descriptor.risk === "destructive" || request.descriptor.critical === true;
      if (!critical && !isAutomation(request)) void decide(request, intent === "approve");
    }
    clearIntent();
  }, [voice.intent, decide, clearIntent]);

  const endSession = () => {
    if (leaving) return;
    setLeavingState(voice.state);
    setLeaving(true);
    setDrawerOpen(false);
    voice.stop();
    leaveTimerRef.current = setTimeout(() => {
      setLeaving(false);
      setLeavingState(undefined);
      onSessionEnd?.();
    }, reducedMotion() ? 0 : EXIT_BEAT_MS);
  };

  const displayState = leavingState ?? voice.state;
  // P-C: the presence owns the stage only until the first view lands.
  const docked = voice.views.length > 0 && !leaving;
  const blobState = voiceBlobState(displayState, voice.muted);
  const status = displayState === "error" ? voice.error?.message ?? STATUS_COPY.error : STATUS_COPY[displayState];
  const tickerLines = voice.transcript.slice(-3);

  // P-C dock morph: FLIP the head's travel on the MorphSurface spring. The
  // pre-flip rect is captured after every paint; on the docked flip the head
  // glides (translate-only — text never scale-stretches) while the ball
  // remounts at the pill diameter.
  const headRectRef = useRef<DOMRect | null>(null);
  const prevDockedRef = useRef(docked);
  useEffect(() => {
    headRectRef.current = headRef.current?.getBoundingClientRect() ?? null;
  });
  useLayoutEffect(() => {
    if (prevDockedRef.current === docked) return;
    prevDockedRef.current = docked;
    const head = headRef.current;
    const before = headRectRef.current;
    if (!head || !before || reducedMotion() || typeof head.animate !== "function") return;
    const after = head.getBoundingClientRect();
    const dx = (before.left + before.width / 2) - (after.left + after.width / 2);
    const dy = (before.top + before.height / 2) - (after.top + after.height / 2);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    head.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
      { duration: DOCK_SPRING_MS, easing: DOCK_SPRING },
    );
  }, [docked]);

  // S-F: the vignette follows the beat — the ball while the agent speaks
  // center-stage, the focused card once docked, off while the user talks.
  const spotOn = displayState === "speaking" && !leaving;
  const spotVars = docked
    ? { "--fl-spot-x": "50%", "--fl-spot-y": "55%", "--fl-spot-r": "320px" }
    : { "--fl-spot-x": "50%", "--fl-spot-y": "22%", "--fl-spot-r": "210px" };

  // P-F: lean toward whoever holds the turn — center-stage only.
  const lean = docked ? undefined
    : displayState === "listening" ? "is-lean-user"
      : displayState === "speaking" ? "is-lean-agent"
        : undefined;
  const blobClasses = [
    displayState === "listening" ? "fl-approval-listening" : undefined,
    lean,
  ].filter(Boolean).join(" ") || undefined;

  const pendingConnect = voice.connects[0];

  const ticker = (
    <div className="fl-voice-caption" aria-label="Live captions" aria-live="polite">
      {tickerLines.map((entry, index) => (
        <span
          key={entry.id}
          className={`fl-voice-tick is-${entry.role === "user" ? "user" : "agent"} is-age-${tickerLines.length - 1 - index}${entry.final ? " is-settled" : ""}`}
        >
          {entry.text}
        </span>
      ))}
    </div>
  );

  return (
    <ChromeRoot className="fl-voice-root">
      <section
        ref={stageRef}
        aria-label="Voice session"
        className={`fl-voice-stage is-${displayState}${leaving ? " is-leaving" : ""}${docked ? " is-docked" : ""}${spotOn ? " is-spot-on" : ""}`}
        data-state={displayState}
        style={spotVars as CSSProperties}
      >
        <div className={`fl-voice-canvas${voice.views.length > 0 ? " has-views" : ""}`}>
          <div className="fl-voice-lift" aria-hidden="true" />
          <div ref={headRef} className="fl-voice-head">
            <VoiceBlob
              state={blobState}
              className={blobClasses}
              amplitude={voice.amplitude}
              size={docked ? DOCKED_BALL_SIZE : STAGE_BALL_SIZE}
            />
            {!docked && displayState === "listening" ? <span className="fl-voice-glow" aria-hidden="true" /> : null}
            <div className="fl-voice-status" role="status" aria-label="Voice status" aria-live="polite">
              {voice.muted && active ? "Muted" : status}
            </div>
            {docked ? null : ticker}
            {displayState === "idle" && !leaving && suggestions !== undefined && suggestions.length > 0 ? (
              <div className="fl-voice-invite" role="group" aria-label="Suggestions">
                {suggestions.slice(0, 3).map((text) => (
                  <button key={text} type="button" className="fl-voice-chip" onClick={voice.start}>
                    {text}
                  </button>
                ))}
                <span className="fl-voice-invite-hint">or just start talking</span>
              </div>
            ) : null}
          </div>

          <VoiceFeed views={voice.views} />
        </div>
        {docked ? ticker : null}
        <span className="fl-voice-spot" aria-hidden="true" />

        {displayState === "reconnecting" ? (
          <div className="fl-voice-banner" role="status" aria-live="polite">Reconnecting…</div>
        ) : null}
        {voice.state === "error" && !leaving ? (
          <div className="fl-voice-banner" role="alert">
            <span>{voice.error?.message ?? STATUS_COPY.error}</span>
            <button type="button" className="fl-btn" onClick={voice.start}>Retry</button>
          </div>
        ) : null}

        {pendingConnect && active && !leaving ? (
          <div className="fl-voice-connect" role="status" aria-live="polite">
            <ConnectCard
              connector={pendingConnect.connector}
              toolkit={pendingConnect.toolkit}
              message={pendingConnect.message}
              onConnected={() => voice.dismissConnect(pendingConnect.id)}
            />
          </div>
        ) : null}

        <VoiceConsent
          request={pendingApproval}
          receipt={approvals.receipt}
          listening={voice.state === "listening"}
          busy={approvals.busyId === pendingApproval?.id}
          error={approvals.error}
          intent={voice.intent}
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
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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

  /** Scrolls ONLY the feed. `scrollIntoView` would also scroll every scrollable
      ancestor — in an embedded host that yanks the host page (voice-lane find). */
  const centerSlide = useCallback((id: string | undefined, behavior: ScrollBehavior) => {
    const feed = feedRef.current;
    const slide = findSlide(feed, id);
    if (!feed || !slide || typeof feed.scrollTo !== "function") return;
    feed.scrollTo({ top: slide.offsetTop - (feed.clientHeight - slide.offsetHeight) / 2, behavior });
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
      const behavior: ScrollBehavior = reducedMotion() ? "auto" : "smooth";
      centerSlide(newest?.id, behavior);
      // The lift morph animates the grid for .55s — a centering measured
      // mid-animation is wrong; re-center once the rows settle.
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      settleTimerRef.current = setTimeout(() => centerSlide(newest?.id, behavior), LIFT_SETTLE_MS);
    }
    previousCountRef.current = views.length;
  }, [views, centerSlide]);

  useEffect(() => () => {
    if (typeof cancelAnimationFrame !== "undefined" && focusFrameRef.current !== undefined) {
      cancelAnimationFrame(focusFrameRef.current);
    }
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
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
    centerSlide(view.id, reducedMotion() ? "auto" : "smooth");
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

function voiceBlobState(state: VoiceState, muted: boolean): VoiceBlobState {
  if (muted && ACTIVE_STATES.has(state)) return "muted";
  if (state === "unavailable" || state === "idle") return "muted";
  return state;
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
