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
  // Id of the root node we initialized with — a different id means a new tree.
  const rootIdRef = useRef<string | null>(null);
  // Keep a stable ref to onAction so the mount effect doesn't go stale.
  const onActionRef = useRef<OnAction | undefined>(onAction);
  useEffect(() => { onActionRef.current = onAction; }, [onAction]);

  // bundleSource / reactSource are mount-only — capture their initial values so
  // we can warn (rather than silently ignore) if they change after init.
  const bundleSourceRef = useRef(bundleSource);
  const reactSourceRef = useRef(reactSource);

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
      rootIdRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Initialize or update whenever node changes (after ready).
  useEffect(() => {
    const c = ctrlRef.current;
    if (!c || !node) return;
    let cancelled = false;
    c.ready
      .then(() => {
        if (cancelled) return;
        if (!initedRef.current) {
          c.initialize({ theme, state, bundleSource, tree: node });
          initedRef.current = true;
          rootIdRef.current = node.id;
        } else if (node.id !== rootIdRef.current) {
          // The root id changed → this is a new tree. Re-initialize (a plain
          // update would target a nodeId that no longer exists and no-op).
          c.initialize({ theme, state, bundleSource, tree: node });
          rootIdRef.current = node.id;
        } else {
          c.update({ replace: { nodeId: node.id, node } });
        }
      })
      .catch((err) => console.error("[flowlet] stage failed to become ready", err));
    return () => { cancelled = true; };
  }, [node]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mount-only props: warn loudly if they change after init instead of silently
  // dropping the change.
  useEffect(() => {
    if (!initedRef.current) return;
    if (bundleSource !== bundleSourceRef.current) {
      console.warn("[flowlet] bundleSource changed after init; ignored (mount-only).");
    }
    if (reactSource !== reactSourceRef.current) {
      console.warn("[flowlet] reactSource changed after init; ignored (mount-only).");
    }
  }, [bundleSource, reactSource]);

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
