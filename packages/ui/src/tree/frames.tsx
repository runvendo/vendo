import { Component, useEffect, useRef, useState, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import type { Json, ToolOutcome, UIPayload } from "@vendoai/core";
import type { OpenSurface } from "../wire-types.js";
import { ContainedNotice } from "./notice.js";
import { PayloadView } from "./renderer.js";
import { Skeleton } from "./primitives.js";

/**
 * Wave 7 H2 — the served-surface keepalive seam. An embedded served app dies
 * under the user when its machine idles out; `ping` (client.apps.pingMachine)
 * is the host-proxied activity signal that keeps it awake, and a "woke" ping
 * means the machine had slept — the current URL is stale, so the frame shows
 * the existing resuming cover and calls `reopen` (useApp().refresh) for the
 * fresh one. One re-open per detection; no reconnect daemon.
 */
export interface AppFrameKeepalive {
  ping(): Promise<{ state: "awake" | "woke" }>;
  reopen(): Promise<unknown>;
  /** Activity-check cadence (default 60s) — pings are at most one per tick. */
  intervalMs?: number;
}

export interface AppFrameProps {
  surface: OpenSurface;
  components?: Record<string, ComponentType>;
  data?: Record<string, Json>;
  onAction?(req: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome>;
  onStateChange?(state: Record<string, Json>): void;
  /** Keepalive for an embedded served app (http surfaces only). */
  keepalive?: AppFrameKeepalive;
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

/** The dimmed, non-interactive wake/loading state — the `resuming` surface,
 *  and what an http frame shows while a keepalive re-open is in flight. */
function ResumingCover({ cover }: { cover?: string }) {
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
      {cover
        ? <img src={cover} alt="App loading cover" style={{ display: "block", width: "100%" }} />
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

/** The embedded served app (Wave 7 H2): the iframe plus its keepalive loop. */
function HttpFrame({ url, keepalive }: { url: string; keepalive?: AppFrameKeepalive }) {
  const [reopening, setReopening] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // A fresh surface URL is the re-open landing: show the new frame.
  useEffect(() => setReopening(false), [url]);
  useEffect(() => {
    if (keepalive === undefined || typeof window === "undefined") return undefined;
    let activity = false;
    let busy = false;
    const mark = () => { activity = true; };
    const events = ["pointerdown", "pointermove", "keydown", "wheel"] as const;
    for (const name of events) window.addEventListener(name, mark, { passive: true });
    const tick = async () => {
      if (busy || document.visibilityState === "hidden") return;
      // Activity INSIDE the cross-origin iframe is invisible to the host
      // page; the frame holding focus is that activity's observable signal.
      const active = activity || document.activeElement === frameRef.current;
      activity = false;
      if (!active) return;
      busy = true;
      try {
        // An unreachable ping is the same stale-frame symptom as a woke one.
        const { state } = await keepalive.ping().catch(() => ({ state: "woke" as const }));
        if (state === "woke") {
          // The machine had slept: every wake mints a new ingress URL, so
          // this one is stale. Cover the frame and swap in the re-opened
          // one. Exactly ONE re-open per detection, its failure absorbed —
          // never a retry loop, never a second re-open.
          setReopening(true);
          await keepalive.reopen().catch(() => undefined);
        }
      } finally {
        busy = false;
        setReopening(false);
      }
    };
    const timer = window.setInterval(() => { void tick(); }, keepalive.intervalMs ?? 60_000);
    return () => {
      window.clearInterval(timer);
      for (const name of events) window.removeEventListener(name, mark);
    };
  }, [keepalive]);
  if (reopening) return <ResumingCover />;
  return (
    <iframe
      key={url}
      ref={frameRef}
      title="Vendo app"
      src={url}
      sandbox={httpFrameSandbox(url)}
      style={{ width: "100%", minHeight: "var(--vendo-app-frame-height, 320px)", border: 0 }}
    />
  );
}

/** 08-ui §5; 06-apps §1 — render every app execution plane fail-soft. */
export function AppFrame({ surface, components = {}, data, onAction = unavailableAction, onStateChange, keepalive }: AppFrameProps) {
  if (surface.kind === "http") {
    return <HttpFrame url={surface.url} keepalive={keepalive} />;
  }

  if (surface.kind === "resuming") {
    return <ResumingCover cover={surface.cover} />;
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

/** 06-apps §8 — an approved pin may degrade; the original product remains. */
export class PinMount extends Component<PinBoundaryProps, PinBoundaryState> {
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
