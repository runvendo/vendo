import { useEffect, useRef } from "react";
import {
  createStage,
  connectStage,
  createGenUISession,
  type StageController,
  type OnAction,
  type GenUISession,
} from "@flowlet/stage";
import {
  isGeneratedNode,
  collectBindings,
  resolvePointer,
  type UINode,
  type GeneratedPayload,
  type RegisteredComponent,
} from "@flowlet/core";

/** Stable structural fingerprint of a payload's node graph (data excluded). */
const nodesKey = (payload: GeneratedPayload): string => JSON.stringify(payload.nodes);

export interface FlowletStageProps {
  node: UINode | null;
  bundleSource?: string;
  reactSource?: string;
  theme?: Record<string, string>;
  state?: Record<string, unknown>;
  onAction?: OnAction;
  /** F1 component registry; generated host-node props are validated against it. */
  components?: RegisteredComponent[];
}

export function FlowletStage({
  node,
  bundleSource = "",
  reactSource,
  theme = {},
  state = {},
  onAction,
  components,
}: FlowletStageProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<StageController | null>(null);
  const initedRef = useRef(false);
  // Id of the root node we initialized with — a different id means a new tree.
  const rootIdRef = useRef<string | null>(null);
  // Live GenUI session + the payload it was built from, for generated nodes.
  const sessionRef = useRef<GenUISession | null>(null);
  const payloadRef = useRef<GeneratedPayload | null>(null);
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
      // Drop the generated session/payload too, so a remount re-initializes
      // instead of taking the data-delta path against an uninitialized stage.
      sessionRef.current = null;
      payloadRef.current = null;
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

        if (isGeneratedNode(node)) {
          // Generated nodes are resolved host-side via a GenUISession; structure
          // changes re-initialize, while pure data changes stream prop-level deltas.
          const payload = node.payload as GeneratedPayload;
          const session = sessionRef.current;
          const prev = payloadRef.current;
          const sameStructure =
            session !== null &&
            prev !== null &&
            prev.root === payload.root &&
            nodesKey(prev) === nodesKey(payload);

          if (!sameStructure) {
            const result = createGenUISession(node.payload, { registry: components });
            if (!result.ok) {
              // Surface the validation error AND render a visible top-level error
              // node (spec §6) instead of silently leaving a stale/blank tree.
              console.error("[flowlet] invalid generated payload", result.error);
              const errorTree: UINode = {
                id: node.id,
                kind: "component",
                source: "prewired",
                name: "Text",
                props: { text: "Failed to render generated UI: " + result.error.message },
              };
              c.initialize({ theme, state, bundleSource, tree: errorTree });
              initedRef.current = true;
              rootIdRef.current = node.id;
              // Drop any prior session so the next valid payload re-initializes
              // rather than taking the (stale) data-delta path.
              sessionRef.current = null;
              payloadRef.current = null;
              return;
            }
            sessionRef.current = result.session;
            payloadRef.current = payload;
            // First init OR a new structure both re-initialize with the resolved
            // tree (mirrors the non-generated re-init path).
            c.initialize({ theme, state, bundleSource, tree: result.session.tree });
            initedRef.current = true;
            rootIdRef.current = node.id;
            return;
          }

          // Same structure, possibly changed data → drive a prop-level ui-delta.
          const data = payload.data ?? {};
          const pointers = new Set(payload.nodes.flatMap(collectBindings));
          const replacements = new Map<string, UINode>();
          for (const pointer of pointers) {
            for (const { nodeId, node: replacement } of session!.applyDataPatch(
              pointer,
              resolvePointer(data, pointer),
            )) {
              replacements.set(nodeId, replacement); // last write wins
            }
          }
          for (const [nodeId, replacement] of replacements) {
            c.update({ replace: { nodeId, node: replacement } });
          }
          payloadRef.current = payload;
          return;
        }

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
