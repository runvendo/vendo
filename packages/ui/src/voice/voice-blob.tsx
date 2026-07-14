import { useEffect, useRef, useState, type ComponentType } from "react";
import type { VoiceBallProps, VoiceBallMode } from "fluidkit";

export type VoiceBlobState =
  | "connecting"
  | "reconnecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "muted"
  | "error";

export interface VoiceBlobProps {
  state: VoiceBlobState;
  /** 0..1 live level; drives the ball (mic while listening, agent while speaking). */
  amplitude?: number;
  /** Diameter of the presence in px. */
  size?: number;
}

type VoiceBallComponent = ComponentType<VoiceBallProps>;

// Same one-load-per-session pattern as FluidThinking — the presence is the
// fluidkit voice ball. `undefined` = not attempted, `null` = off.
let cached: VoiceBallComponent | null | undefined;

/** Stage state → VoiceBall's three-mode register. `muted`/`error` never reach
 *  the ball (they render the frozen disc): a lively ball that isn't listening
 *  reads as a lie. `thinking` is a calm working breathe (idle), not attentive. */
const MODE: Record<VoiceBlobState, VoiceBallMode> = {
  connecting: "idle",
  reconnecting: "idle",
  listening: "listening",
  thinking: "idle",
  speaking: "speaking",
  muted: "idle",
  error: "idle",
};

/**
 * The voice presence — fluidkit's `VoiceBall` (0.5), a liquid glass bead tinted
 * by the host's accent. fluidkit is an enhancement layer: a static disc paints
 * immediately (and is all reduced-motion ever animates); the ball takes over
 * when the chunk resolves. Muted/error freeze to the disc deliberately.
 */
export function VoiceBlob({ state, amplitude = 0, size = 96 }: VoiceBlobProps) {
  const [VoiceBall, setVoiceBall] = useState<VoiceBallComponent | null>(() => cached ?? null);
  const [reduced, setReduced] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // The ball's glass fill needs a CONCRETE color (the accent is defined via
  // light-dark()); read it off the mounted element's resolved `color`.
  const [tint, setTint] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof getComputedStyle === "undefined") return;
    const resolved = getComputedStyle(el).color;
    if (resolved) setTint(resolved);
  }, []);

  useEffect(() => {
    if (cached !== undefined) return;
    let alive = true;
    import("fluidkit").then(
      (mod) => {
        cached = mod.VoiceBall;
        if (alive) setVoiceBall(() => mod.VoiceBall);
      },
      () => {
        cached = null;
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const still = state === "muted" || state === "error";
  const fluid = VoiceBall && !reduced && !still;

  return (
    <div
      ref={ref}
      className={`fl-voice-blob is-${state}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {fluid ? (
        <VoiceBall
          mode={MODE[state]}
          level={Math.max(0, Math.min(1, amplitude))}
          size={size}
          tint={tint}
          opacity={0.58}
          intensity="whisper"
        />
      ) : (
        <span className="fl-voice-disc" />
      )}
      {(state === "muted" || state === "error") && (
        <span className="fl-voice-glyph">
          {state === "muted" ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="2" y1="2" x2="22" y2="22" />
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12" /><path d="M15 9.34V5a3 3 0 0 0-5.94-.6" />
              <path d="M5 10v1a7 7 0 0 0 12 5" /><path d="M19 10v1a7 7 0 0 1-.64 2.9" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          )}
        </span>
      )}
    </div>
  );
}
