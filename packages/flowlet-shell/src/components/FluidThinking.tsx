import { useEffect, useState, type ComponentType } from "react";
import type { ThinkingProps } from "fluidkit";

type ThinkingComponent = ComponentType<ThinkingProps>;

// Module-level so the import (or its failure) is paid once per session, not
// once per streaming turn. `undefined` = not attempted, `null` = unavailable.
let cached: ThinkingComponent | null | undefined;

export interface FluidThinkingProps {
  /** Accessible label for the working state. */
  label?: string;
}

/**
 * The agent-liveness indicator. fluidkit is an enhancement layer: the legacy
 * static dots paint immediately (and are all reduced-motion CSS ever animates),
 * then fluidkit's metaball Thinking takes over once its chunk resolves. If the
 * library is missing or fails to load, the dots simply stay — the shell never
 * depends on it to function.
 */
export function FluidThinking({ label = "Working" }: FluidThinkingProps) {
  // Initializer form: the cached value is itself a function component, and a
  // bare function passed to useState would be invoked as a lazy initializer.
  const [Thinking, setThinking] = useState<ThinkingComponent | null>(() => cached ?? null);

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

  if (!Thinking) {
    return (
      <div className="fl-typing" aria-label={label}>
        <span />
        <span />
        <span />
      </div>
    );
  }
  return (
    <div className="fl-thinking">
      <Thinking label={label} material="flat" size={9} spread={30} />
    </div>
  );
}
