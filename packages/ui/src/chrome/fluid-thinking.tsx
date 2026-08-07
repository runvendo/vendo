export interface FluidThinkingProps {
  /** Accessible label for the working state. */
  label?: string;
}

/** The agent-liveness indicator: three staggered bouncing dots. */
export function FluidThinking({ label = "Working" }: FluidThinkingProps) {
  return (
    <div className="fl-typing" aria-label={label}>
      <span />
      <span />
      <span />
    </div>
  );
}
