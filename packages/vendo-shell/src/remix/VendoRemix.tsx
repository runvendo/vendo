import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { validateGeneratedPayload, type UINode } from "@vendoai/core";
import { useShell } from "../context";
import { diffHostComponents } from "../component-drift";
import type { RemixPin } from "../seams/remixes";
import { snapshotElement } from "./snapshot";

/** Fired (with `detail.anchorId`) whenever a pin changes, so mounted wrappers
 *  reload without prop drilling — same pattern as vendo:integrations-changed. */
export const REMIX_CHANGED_EVENT = "vendo:remix-changed";

export interface VendoRemixProps {
  /** Stable identity for persistence and context. */
  id: string;
  /** Human name the agent and the scoped overlay header use. */
  label?: string;
  /** Serializable data describing the wrapped thing; feeds the agent and
   *  flows into a pinned remix as live data on every render. */
  context?: unknown;
  /** The wrapper is one real div in the host's layout — layout classes that
   *  used to sit on the wrapped child (grid spans, widths) belong here. */
  className?: string;
  /** Show the ✦ affordance on hover/focus by default, or keep it visible. */
  affordance?: "hover" | "always";
  children: ReactNode;
}

/** A pinned node ready to render, or why it can't be. */
type PinnedState =
  | { kind: "none" }
  | { kind: "ready"; node: UINode }
  | { kind: "broken" };

/** Fail-open guarantee at render time: a pinned view that THROWS while
 *  rendering must fall back to the host's original children, never take the
 *  host page down. (Async failures inside the sandbox iframe render the
 *  stage's own contained error; surfacing those needs a renderNode failure
 *  callback — declared follow-up.) */
class RemixBoundary extends Component<
  { fallback: ReactNode; onBroken: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    console.warn("[vendo] pinned remix failed to render; showing the host default", error);
    this.props.onBroken();
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * VendoRemix (2026-07-04 spec): wrap any host component; it renders exactly
 * as-is by default. A ✦ affordance (hover/focus) opens the shared overlay
 * scoped to this element with a DOM baseline snapshot; applied customizations
 * render in place with a "customized · reset" pill, fail-open to the original
 * children on any error or drift. SSR renders children only.
 */
export function VendoRemix({
  id,
  label,
  context,
  className,
  affordance = "hover",
  children,
}: VendoRemixProps) {
  const { registry, remixes, renderNode, scope, components } = useShell();
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Client-only affordance: nothing beyond children exists until after mount.
  const [mounted, setMounted] = useState(false);
  const [pin, setPin] = useState<RemixPin | null>(null);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    return registry.register({
      anchorId: id,
      ...(label !== undefined ? { label } : {}),
      ...(context !== undefined ? { context } : {}),
      getSnapshot: () => (hostRef.current ? snapshotElement(hostRef.current) : undefined),
    });
  }, [registry, id, label, context]);

  // Guarded against unmount/id changes: a slow store resolving late must not
  // set a stale pin, and a pin for a different anchor never renders here.
  const loadToken = useRef(0);
  const reload = useCallback(() => {
    const token = ++loadToken.current;
    remixes
      .get(id)
      .then((loaded) => {
        if (loadToken.current !== token) return;
        setPin(loaded && loaded.anchorId === id ? loaded : null);
      })
      .catch((err) => {
        console.warn(`[vendo] failed to load remix pin for "${id}"`, err);
        if (loadToken.current === token) setPin(null);
      });
  }, [remixes, id]);
  useEffect(() => {
    reload();
    return () => {
      loadToken.current++; // invalidate in-flight loads on unmount/id change
    };
  }, [reload]);
  useEffect(() => {
    const onChange = (e: Event) => {
      if ((e as CustomEvent<{ anchorId?: string }>).detail?.anchorId === id) reload();
    };
    window.addEventListener(REMIX_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(REMIX_CHANGED_EVENT, onChange);
  }, [id, reload]);

  // The pinned view with the anchor's CURRENT context patched in at
  // `data.anchor` (the binding path the engine instructs the model to use),
  // re-validated every time — an invalid patch fails open, never renders.
  const pinned = useMemo<PinnedState>(() => {
    if (!pin) return { kind: "none" };
    const node = pin.node;
    if (node.kind !== "generated" || node.payload === null || typeof node.payload !== "object") {
      return { kind: "broken" };
    }
    const drift = diffHostComponents(pin.components, components ?? []);
    if (drift.missing.length > 0 || drift.changed.length > 0) return { kind: "broken" };
    const payload = node.payload as Record<string, unknown>;
    const patched =
      context !== undefined
        ? {
            ...payload,
            data: { ...((payload["data"] as Record<string, unknown>) ?? {}), anchor: context },
          }
        : payload;
    if (!validateGeneratedPayload(patched).ok) return { kind: "broken" };
    return { kind: "ready", node: { ...node, payload: patched } };
  }, [pin, context, components]);

  const openScoped = () => {
    scope.open({
      anchorId: id,
      ...(label !== undefined ? { label } : {}),
      ...(context !== undefined ? { context } : {}),
      ...(hostRef.current ? { snapshot: snapshotElement(hostRef.current) } : {}),
      // The pin's sealed envelope rides along so the agent can patch the
      // CURRENT customization (base:"pin") instead of starting over.
      ...(pin?.envelope !== undefined ? { envelope: pin.envelope } : {}),
    });
  };

  const reset = () => {
    void remixes
      .unpin(id)
      .then(() => setPin(null))
      .catch((err) => console.warn(`[vendo] failed to reset remix for "${id}"`, err));
  };

  // A render-time crash inside the pinned view flips it to broken (fail-open).
  const [renderBroken, setRenderBroken] = useState(false);
  useEffect(() => setRenderBroken(false), [pin]);

  const customized = mounted && pin !== null;
  const showPinned = customized && pinned.kind === "ready" && !renderBroken;
  return (
    <div
      className={className ? `fl-remix ${className}` : "fl-remix"}
      data-vendo-remix={id}
    >
      <div ref={hostRef} className="fl-remix-host">
        {showPinned ? (
          <RemixBoundary fallback={children} onBroken={() => setRenderBroken(true)}>
            {renderNode(pinned.node)}
          </RemixBoundary>
        ) : (
          children
        )}
      </div>
      {mounted && (
        <button
          type="button"
          className="fl-remix-btn"
          data-affordance={affordance}
          aria-label={`Ask about ${label ?? "this"}`}
          title={`Ask about ${label ?? "this"}`}
          onClick={openScoped}
        >
          ✦
        </button>
      )}
      {customized && (
        <div className="fl-remix-pill" data-state={showPinned ? "active" : "broken"}>
          <span>✦ {showPinned ? "customized" : "customization unavailable"}</span>
          {!showPinned && (
            <button type="button" className="fl-remix-pill-act" onClick={openScoped}>
              retry
            </button>
          )}
          <button type="button" className="fl-remix-pill-act" onClick={reset}>
            reset
          </button>
        </div>
      )}
    </div>
  );
}
