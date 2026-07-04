import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { validateGeneratedPayload, type UINode } from "@flowlet/core";
import { useShell } from "../context";
import { diffHostComponents } from "../component-drift";
import type { RemixPin } from "../seams/remixes";
import { snapshotElement } from "./snapshot";

/** Fired (with `detail.anchorId`) whenever a pin changes, so mounted wrappers
 *  reload without prop drilling — same pattern as flowlet:integrations-changed. */
export const REMIX_CHANGED_EVENT = "flowlet:remix-changed";

export interface FlowletRemixProps {
  /** Stable identity for persistence and context. */
  id: string;
  /** Human name the agent and the scoped overlay header use. */
  label?: string;
  /** Serializable data describing the wrapped thing; feeds the agent and
   *  flows into a pinned remix as live data on every render. */
  context?: unknown;
  children: ReactNode;
}

/** A pinned node ready to render, or why it can't be. */
type PinnedState =
  | { kind: "none" }
  | { kind: "ready"; node: UINode }
  | { kind: "broken" };

/**
 * FlowletRemix (2026-07-04 spec): wrap any host component; it renders exactly
 * as-is by default. A ✦ affordance (hover/focus) opens the shared overlay
 * scoped to this element with a DOM baseline snapshot; applied customizations
 * render in place with a "customized · reset" pill, fail-open to the original
 * children on any error or drift. SSR renders children only.
 */
export function FlowletRemix({ id, label, context, children }: FlowletRemixProps) {
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

  const reload = useCallback(() => {
    remixes
      .get(id)
      .then(setPin)
      .catch((err) => {
        console.warn(`[flowlet] failed to load remix pin for "${id}"`, err);
        setPin(null);
      });
  }, [remixes, id]);
  useEffect(reload, [reload]);
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
    });
  };

  const reset = () => {
    void remixes
      .unpin(id)
      .then(() => setPin(null))
      .catch((err) => console.warn(`[flowlet] failed to reset remix for "${id}"`, err));
  };

  const customized = mounted && pin !== null;
  return (
    <div className="fl-remix" data-flowlet-remix={id}>
      <div ref={hostRef} className="fl-remix-host">
        {customized && pinned.kind === "ready" ? renderNode(pinned.node) : children}
      </div>
      {mounted && (
        <button
          type="button"
          className="fl-remix-btn"
          aria-label={`Ask about ${label ?? "this"}`}
          title={`Ask about ${label ?? "this"}`}
          onClick={openScoped}
        >
          ✦
        </button>
      )}
      {customized && (
        <div className="fl-remix-pill" data-state={pinned.kind === "ready" ? "active" : "broken"}>
          <span>✦ {pinned.kind === "ready" ? "customized" : "customization unavailable"}</span>
          {pinned.kind === "broken" && (
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
