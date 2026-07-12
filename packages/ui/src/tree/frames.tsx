import { Component, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import type { Json, ToolOutcome, UIPayload } from "@vendoai/core";
import type { OpenSurface } from "../wire-types.js";
import { ContainedNotice } from "./notice.js";
import { PayloadView } from "./renderer.js";
import { Skeleton } from "./primitives.js";

export interface AppFrameProps {
  surface: OpenSurface;
  components?: Record<string, ComponentType>;
  data?: Record<string, Json>;
  onAction?(req: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome>;
  onStateChange?(state: Record<string, Json>): void;
}

const unavailableAction = async (): Promise<ToolOutcome> => ({
  status: "error",
  error: { code: "not-implemented", message: "No app action handler was provided." },
});

/**
 * The rung-4 machine URL is the sandbox provider's, always cross-origin to the
 * host page (09 §3), so `allow-same-origin` gives the app ITS OWN provider
 * origin — needed for the app's storage/cookies/auth, and it can reach nothing
 * of the host's. But `allow-scripts` + `allow-same-origin` on a SAME-ORIGIN url
 * would run the framed app in the HOST origin with full access to host storage,
 * cookies, and same-origin APIs — the app holding host authority, which the one
 * security rule forbids (06 §9). ui cannot assume the URL is well-formed, so it
 * grants same-origin ONLY when the resolved origin differs from the host's; a
 * same-origin or unresolvable url runs opaque (no `allow-same-origin`) and can
 * touch nothing. A genuine machine surface is unaffected.
 */
function httpFrameSandbox(url: string): string {
  const base = "allow-scripts allow-forms";
  if (typeof window === "undefined") return base; // SSR: no host origin to compare against
  try {
    if (new URL(url, window.location.href).origin !== window.location.origin) {
      return `${base} allow-same-origin`;
    }
  } catch {
    // Unparseable URL → treat as untrusted, stay opaque.
  }
  return base;
}

/** 08-ui §5; 06-apps §1 — render every app execution plane fail-soft. */
export function AppFrame({ surface, components = {}, data, onAction = unavailableAction, onStateChange }: AppFrameProps) {
  if (surface.kind === "http") {
    return (
      <iframe
        title="Vendo app"
        src={surface.url}
        sandbox={httpFrameSandbox(surface.url)}
        style={{ width: "100%", minHeight: "var(--vendo-app-frame-height, 320px)", border: 0 }}
      />
    );
  }

  if (surface.kind === "resuming") {
    return (
      <div
        aria-label="Vendo app resuming"
        aria-busy="true"
        style={{
          position: "relative",
          pointerEvents: "none",
          opacity: "var(--vendo-resuming-opacity, 0.55)",
          background: "var(--vendo-color-surface, #f7f7f8)",
          borderRadius: "var(--vendo-radius-medium, 10px)",
          overflow: "hidden",
        }}
      >
        {surface.cover
          ? <img src={surface.cover} alt="App loading cover" style={{ display: "block", width: "100%" }} />
          : <Skeleton height="var(--vendo-app-frame-height, 320px)" />}
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            background: "var(--vendo-color-background, #ffffff)",
            opacity: "var(--vendo-resuming-overlay-opacity, 0.18)",
          }}
        />
      </div>
    );
  }

  if (surface.kind === "tree") {
    const payload: UIPayload = surface.components
      ? { ...surface.payload, components: surface.components }
      : surface.payload;
    return (
      <PayloadView
        payload={payload}
        components={components}
        data={data}
        onAction={onAction}
        onStateChange={onStateChange}
      />
    );
  }

  const unknown = surface as { kind?: unknown };
  return (
    <ContainedNotice label="Unsupported app surface">
      {`Unsupported app surface "${String(unknown.kind)}".`}
    </ContainedNotice>
  );
}

interface PinBoundaryProps {
  children: ReactNode;
  fallback: ComponentType;
  slot: string;
}

interface PinBoundaryState {
  failed: boolean;
}

class PinErrorBoundary extends Component<PinBoundaryProps, PinBoundaryState> {
  state: PinBoundaryState = { failed: false };

  static getDerivedStateFromError(): PinBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The original component is the visible recovery path.
  }

  componentDidUpdate(previous: PinBoundaryProps): void {
    if (previous.slot !== this.props.slot && this.state.failed) this.setState({ failed: false });
  }

  render() {
    const Fallback = this.props.fallback;
    return this.state.failed ? <Fallback /> : this.props.children;
  }
}

/** 06-apps §8 — an approved pin may degrade; the original product remains. */
export function PinMount(props: PinBoundaryProps) {
  return <PinErrorBoundary {...props} />;
}
