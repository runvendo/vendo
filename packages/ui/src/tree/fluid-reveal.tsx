import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The ENG-205 render-slot morph, finally wired: a persistent wrapper that a
 * placeholder and its replacing view share, so content changes MORPH instead
 * of popping. When `stateKey` changes, the outgoing subtree is kept for one
 * beat in an absolutely-positioned exit layer (fading, blurring) while the
 * incoming subtree rises in underneath it. Reduced motion is handled by the
 * chrome root attribute rule, which disables all animation wholesale.
 */
export function FluidReveal({
  stateKey,
  children,
  className,
  initialExit,
}: {
  /** Identity of the current content; a change triggers the morph. */
  stateKey: string;
  children: ReactNode;
  className?: string;
  /**
   * Content to morph FROM on first mount — for wrappers that appear at the
   * same instant the content they replace unmounts elsewhere (a slot taking
   * over from the host's own inline markup).
   */
  initialExit?: ReactNode;
}) {
  const previous = useRef<{ key: string; node: ReactNode }>({ key: stateKey, node: children });
  const [exiting, setExiting] = useState<{ key: string; node: ReactNode } | null>(
    initialExit !== undefined ? { key: "__initial", node: initialExit } : null,
  );

  // Render-phase capture of the outgoing subtree (the documented
  // derived-state-from-props pattern): the switch must be observed on the
  // exact render where the key flips, or the old content is already gone.
  if (previous.current.key !== stateKey) setExiting(previous.current);
  previous.current = { key: stateKey, node: children };

  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => setExiting(null), 480);
    return () => clearTimeout(timer);
  }, [exiting]);

  return (
    <div className={className ? `fl-reveal ${className}` : "fl-reveal"}>
      <div className="fl-reveal-enter" key={stateKey} data-reveal-state={stateKey}>
        {children}
      </div>
      {exiting ? (
        <div className="fl-reveal-exit" aria-hidden="true">
          {exiting.node}
        </div>
      ) : null}
    </div>
  );
}
