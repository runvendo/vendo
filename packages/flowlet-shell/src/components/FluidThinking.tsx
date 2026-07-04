import { Thinking } from "fluidkit";

export interface FluidThinkingProps {
  /** Accessible label for the working state. */
  label?: string;
  /** Drop diameter in px (fluidkit Thinking `size`). */
  size?: number;
  /**
   * Legacy cluster extent in px, from the 0.3 API. 0.5's Thinking sizes its
   * canvas from `size` alone; when only `spread` is given we derive an
   * equivalent `size` from it so old callsites keep their footprint.
   */
  spread?: number;
}

/** 0.5 Thinking canvas = size × 3.5; a legacy `spread` was that extent. */
const CANVAS_SCALE = 3.5;

/**
 * The agent-liveness indicator: fluidkit's metaball Thinking, statically
 * imported. Reduced-motion and missing-capability rendering are fluidkit's
 * tested degradation contract — the shell keeps no fallback of its own.
 */
export function FluidThinking({ label = "Working", size, spread }: FluidThinkingProps) {
  const resolvedSize = size ?? (spread !== undefined ? Math.max(3, Math.round(spread / CANVAS_SCALE)) : 9);
  return (
    <div className="fl-thinking">
      <Thinking label={label} material="flat" size={resolvedSize} />
    </div>
  );
}
