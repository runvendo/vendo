import { useEffect, useRef } from "react";
import { createStage, connectStage, type StageController, type OnAction } from "@flowlet/stage";
import type { UINode } from "@flowlet/core";

export interface FlowletStageProps {
  node: UINode | null;
  bundleSource?: string;
  reactSource?: string;
  theme?: Record<string, string>;
  state?: Record<string, unknown>;
  onAction?: OnAction;
}

export function FlowletStage({
  node,
  bundleSource = "",
  reactSource,
  theme = {},
  state = {},
  onAction,
}: FlowletStageProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<StageController | null>(null);
  const initedRef = useRef(false);
  // Keep a stable ref to onAction so the mount effect doesn't go stale.
  const onActionRef = useRef<OnAction | undefined>(onAction);
  useEffect(() => { onActionRef.current = onAction; }, [onAction]);

  // Mount the stage once into the slot.
  useEffect(() => {
    if (!slotRef.current || ctrlRef.current) return;
    const { iframe, endpoints } = createStage(
      slotRef.current,
      reactSource ? { reactSource } : undefined,
    );
    ctrlRef.current = connectStage(endpoints, {
      onAction: (req) => (onActionRef.current ?? (async () => ({ result: null as unknown })))(req),
    });
    return () => {
      ctrlRef.current?.dispose();
      iframe.remove();
      ctrlRef.current = null;
      initedRef.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Initialize or update whenever node changes (after ready).
  useEffect(() => {
    const c = ctrlRef.current;
    if (!c || !node) return;
    let cancelled = false;
    c.ready.then(() => {
      if (cancelled) return;
      if (!initedRef.current) {
        c.initialize({ theme, state, bundleSource, tree: node });
        initedRef.current = true;
      } else {
        c.update({ nodeId: node.id, node });
      }
    });
    return () => { cancelled = true; };
  }, [node]); // eslint-disable-line react-hooks/exhaustive-deps

  // Propagate theme changes after init.
  useEffect(() => {
    const c = ctrlRef.current;
    if (!c || !initedRef.current) return;
    c.update({ theme });
  }, [theme]); // eslint-disable-line react-hooks/exhaustive-deps

  // Propagate state changes after init.
  useEffect(() => {
    const c = ctrlRef.current;
    if (!c || !initedRef.current) return;
    c.update({ state });
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={slotRef} data-flowlet-stage />;
}
