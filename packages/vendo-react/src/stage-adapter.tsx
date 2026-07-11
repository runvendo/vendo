import { useEffect, useRef } from "react";
import {
  createStage,
  connectStage,
  createGenUISession,
  type StageController,
  type OnAction,
  type GenUISession,
  type StageRoute,
} from "@vendoai/stage";
import {
  isGeneratedNode,
  collectBindings,
  resolvePointer,
  type UINode,
  type GeneratedPayload,
  type RegisteredComponent,
} from "@vendoai/core";

/** Stable structural fingerprint of a payload's node graph and generated
 *  component code (data excluded) — a components-map change (e.g. an LLM
 *  revising a component's source) must re-initialize just like a nodes change.
 *  The components map is a Record with no ordering semantics, so its entries are
 *  sorted by name before stringifying: same content ⇒ same key regardless of key
 *  insertion order. Node array order is meaningful and preserved as-is. */
const structureKey = (payload: GeneratedPayload): string => {
  const components = payload.components ?? {};
  const sortedComponents = Object.keys(components)
    .sort()
    .map((name) => [name, components[name]]);
  return JSON.stringify([payload.nodes, sortedComponents]);
};

/** Inert tree mounted when `node` becomes null: renders nothing, carries no
 *  actions — clearing the node must clear the stage (audit: a stale tree
 *  stayed mounted and actionable). Reserved id so no real node collides. */
const CLEARED_TREE: UINode = {
  id: "__vendo-stage-cleared__",
  kind: "component",
  source: "prewired",
  name: "Text",
  props: { text: "" },
};

export interface VendoStageProps {
  node: UINode | null;
  bundleSource?: string;
  reactSource?: string;
  theme?: Record<string, string>;
  state?: Record<string, unknown>;
  onAction?: OnAction;
  /** F1 component registry; generated host-node props are validated against it. */
  components?: RegisteredComponent[];
  /** Opaque OpenUI theme the sandbox bundle mounts; @vendoai/react does not
   *  interpret its shape. */
  componentTheme?: unknown;
  /** The host's real route (read-only), fed into the sandbox as
   *  `window.__vendoRouteData` so the next/navigation shims resolve the host's
   *  actual location. Supply it from the host's own next/navigation, e.g.
   *  `{ pathname: usePathname(), search: useSearchParams().toString(), params }`.
   *  Omit and the shims fall back to empty values. */
  route?: StageRoute;
}

export function VendoStage({
  node,
  bundleSource = "",
  reactSource,
  theme = {},
  state = {},
  onAction,
  components,
  componentTheme,
  route,
}: VendoStageProps) {
  // Read-only route channel spread into every initialize() so the shims resolve
  // the host's real location regardless of which tree is mounted. Read from a
  // ref (refreshed every render) rather than a render-time snapshot: the node
  // effect waits on `c.ready` before initializing, so a route that changes
  // while the stage is still initializing (node unchanged, so the effect never
  // re-runs; route effect skips because not-yet-inited) would otherwise
  // initialize with the STALE route and never re-run. `routeInit()` reads the
  // latest route at the moment initialize is called.
  // (theme/state are still captured in the effect closure below and share the
  // same latent pre-ready race — left out of scope; only route is fixed here.)
  const routeRef = useRef(route);
  routeRef.current = route;
  const routeInit = () => (routeRef.current ? { route: routeRef.current } : {});
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
    const { iframe, endpoints, dispose: disposeStage } = createStage(
      slotRef.current,
      reactSource ? { reactSource } : undefined,
    );
    ctrlRef.current = connectStage(endpoints, {
      onAction: (req) => (onActionRef.current ?? (async () => ({ result: null as unknown })))(req),
    });
    return () => {
      ctrlRef.current?.dispose();
      disposeStage(); // resize listener does not die with the iframe
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
    if (!c) return;
    let cancelled = false;
    if (!node) {
      // node={null} means "show nothing": an initialized stage must unmount
      // its tree, not leave the previous view visible and actionable. An
      // inert empty tree replaces it (the protocol has no dedicated clear
      // op); the session/payload refs drop too so the next node — generated
      // or not — re-initializes instead of data-delta'ing a cleared tree.
      if (initedRef.current) {
        c.ready
          .then(() => {
            if (cancelled) return;
            c.initialize({ theme, state, bundleSource, componentTheme, ...routeInit(), tree: CLEARED_TREE });
            rootIdRef.current = CLEARED_TREE.id;
            sessionRef.current = null;
            payloadRef.current = null;
          })
          .catch((err) => console.error("[vendo] stage failed to become ready", err));
      }
      return () => { cancelled = true; };
    }
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
            prev.formatVersion === payload.formatVersion &&
            prev.root === payload.root &&
            structureKey(prev) === structureKey(payload);

          if (!sameStructure) {
            const result = createGenUISession(node.payload, { registry: components });
            if (!result.ok) {
              // Surface the validation error AND render a visible top-level error
              // node (spec §6) instead of silently leaving a stale/blank tree.
              console.error("[vendo] invalid generated payload", result.error);
              const errorTree: UINode = {
                id: node.id,
                kind: "component",
                source: "prewired",
                name: "Text",
                props: { text: "Failed to render generated UI: " + result.error.message },
              };
              c.initialize({ theme, state, bundleSource, componentTheme, ...routeInit(), tree: errorTree });
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
            // tree (mirrors the non-generated re-init path). Track the resolved
            // tree's root id — NOT the wrapper GeneratedNode.id — because that is
            // the id actually mounted in the stage; a later non-generated render
            // reusing the wrapper id would otherwise update an unmounted node.
            c.initialize({
              theme,
              state,
              bundleSource,
              componentTheme,
              ...routeInit(),
              tree: result.session.tree,
              generatedComponents: payload.components,
            });
            initedRef.current = true;
            rootIdRef.current = result.session.tree.id;
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

        // A non-generated node is now the root, so any prior generated session
        // no longer reflects what's mounted; drop it so a future generated
        // payload re-initializes rather than taking a stale data-delta path.
        const switchedFromGenerated = sessionRef.current !== null;
        if (switchedFromGenerated) {
          sessionRef.current = null;
          payloadRef.current = null;
        }
        if (!initedRef.current) {
          c.initialize({ theme, state, bundleSource, componentTheme, ...routeInit(), tree: node });
          initedRef.current = true;
          rootIdRef.current = node.id;
        } else if (switchedFromGenerated || node.id !== rootIdRef.current) {
          // New tree (root id changed, or we just switched off a generated tree
          // whose mounted root id differs from this node). Re-initialize — a
          // plain update would target a nodeId that no longer exists and no-op.
          c.initialize({ theme, state, bundleSource, componentTheme, ...routeInit(), tree: node });
          rootIdRef.current = node.id;
        } else {
          c.update({ replace: { nodeId: node.id, node } });
        }
      })
      .catch((err) => console.error("[vendo] stage failed to become ready", err));
    return () => { cancelled = true; };
  }, [node]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mount-only props: warn loudly if they change after init instead of silently
  // dropping the change.
  useEffect(() => {
    if (!initedRef.current) return;
    if (bundleSource !== bundleSourceRef.current) {
      console.warn("[vendo] bundleSource changed after init; ignored (mount-only).");
    }
    if (reactSource !== reactSourceRef.current) {
      console.warn("[vendo] reactSource changed after init; ignored (mount-only).");
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

  // Re-patch the read-only route channel after init when the host route changes.
  useEffect(() => {
    const c = ctrlRef.current;
    if (!c || !initedRef.current || !route) return;
    c.update({ route });
  }, [route]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={slotRef} data-vendo-stage />;
}
