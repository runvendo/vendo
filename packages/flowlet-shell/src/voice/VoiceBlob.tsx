import { useEffect, useState, type ComponentType } from "react";
import type { ThinkingProps } from "fluidkit";

export type VoiceBlobState =
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "muted"
  | "error";

export interface VoiceBlobProps {
  state: VoiceBlobState;
  /** 0..1 live level; breathes the blob (mic while listening, agent while speaking). */
  amplitude?: number;
  /** Diameter of the presence in px. */
  size?: number;
}

type ThinkingComponent = ComponentType<ThinkingProps>;

// Same one-load-per-session pattern as FluidThinking — the blob IS that
// creature, scaled up for the stage. `undefined` = not attempted, `null` = off.
let cached: ThinkingComponent | null | undefined;

/** Per-state motion character for the fluidkit cluster. */
const MOTION: Record<VoiceBlobState, { speed: number; spreadFactor: number }> = {
  connecting: { speed: 0.5, spreadFactor: 0.3 },
  listening: { speed: 0.55, spreadFactor: 0.42 },
  thinking: { speed: 1, spreadFactor: 0.52 },
  speaking: { speed: 1.7, spreadFactor: 0.6 },
  muted: { speed: 0, spreadFactor: 0 },
  error: { speed: 0, spreadFactor: 0 },
};

/**
 * The voice presence — the ENG-205 thinking creature promoted to the stage.
 * fluidkit is an enhancement layer: a static disc paints immediately (and is
 * all reduced-motion ever animates); the metaball cluster takes over when the
 * chunk resolves. Muted/error freeze to the disc deliberately — a lively blob
 * that isn't listening reads as a lie.
 */
export function VoiceBlob({ state, amplitude = 0, size = 72 }: VoiceBlobProps) {
  const [Thinking, setThinking] = useState<ThinkingComponent | null>(() => cached ?? null);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (cached !== undefined) return;
    let alive = true;
    import("fluidkit").then(
      (mod) => {
        cached = mod.Thinking;
        if (alive) setThinking(() => mod.Thinking);
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
  const fluid = Thinking && !reduced && !still;
  const motion = MOTION[state];
  // Amplitude breathes the whole presence; clamped so a hot mic can't balloon it.
  const scale = 1 + Math.max(0, Math.min(1, amplitude)) * 0.14;

  return (
    <div
      className={`fl-voice-blob is-${state}`}
      style={{ width: size, height: size, transform: `scale(${fluid ? scale : 1})` }}
      aria-hidden="true"
    >
      {fluid ? (
        <Thinking
          label=""
          material="flat"
          size={Math.round(size * 0.22)}
          spread={Math.round(size * motion.spreadFactor)}
          speed={motion.speed}
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
