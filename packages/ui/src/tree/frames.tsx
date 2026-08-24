import { Component, useEffect, useMemo, useRef, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import type { Json, ToolOutcome, UIPayload } from "@vendoai/core";
import type { OpenSurface } from "../wire-types.js";
import { useVendoProvider } from "../context.js";
import { themeCssVariables } from "../theme.js";
import { applyFrameResize, isFromFrame, FRAME_MAX_HEIGHT_CSS } from "./frame-resize.js";
import { readFrameCall, replyToFrame, sendFrameTheme } from "./frame-bridge.js";
import { ContainedNotice } from "./notice.js";
import { PayloadView, type ParkedPress } from "./renderer.js";
import { Skeleton } from "./forming-skeleton.js";

/**
 * The served-surface keepalive seam. An embedded served app dies
 * under the user when its machine idles out; `ping` (client.apps.pingMachine)
 * is the host-proxied activity signal that keeps it awake. Activity is the gate,
 * not the timer: a machine costs money by the second, so an embed nobody is
 * using is allowed to sleep.
 *
 * Served-app URLs are stable proxy URLs, so a wake is invisible to the frame:
 * nothing has to be re-opened for a fresh address.
 */
export interface AppFrameKeepalive {
  ping(): Promise<{ state: "awake" | "woke" }>;
  /** Activity-check cadence (default 60s) — pings are at most one per tick. */
  intervalMs?: number;
}

export interface AppFrameProps {
  surface: OpenSurface;
  /**
   * Which app this surface belongs to. A frame that can show a DIFFERENT app in
   * the same position passes it, and the tree surface's `$state` then belongs to
   * that app alone (renderer.tsx's TreeView documents why the tree cannot say).
   */
  appId?: string;
  components?: Record<string, ComponentType>;
  data?: Record<string, Json>;
  onAction?(req: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome>;
  /** A press parked on an approval (tree surfaces only) — renderer.tsx's
   *  TreeViewProps documents what a surface does with it. */
  onParked?: (parked: ParkedPress) => void;
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

/** The dimmed, non-interactive wake/loading state — the `resuming` surface. */
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

/** The embedded served app: the iframe, its keepalive ping, and the resize
 *  protocol every Vendo frame shares. */
function HttpFrame({ url, keepalive }: { url: string; keepalive?: AppFrameKeepalive }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
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
      // Nothing keeps an UNUSED machine awake. A sandbox machine is paid for by
      // the second, so an embed nobody is using has to be allowed to sleep —
      // a tab left open is not use, and pinging on the timer alone would keep
      // every abandoned tab's machine warm forever.
      if (!active) return;
      busy = true;
      try {
        // An unreachable ping is the machine's problem, not the frame's — the
        // URL is stable either way, so there is nothing here to recover.
        await keepalive.ping().catch(() => undefined);
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => { void tick(); }, keepalive.intervalMs ?? 60_000);
    return () => {
      window.clearInterval(timer);
      for (const name of events) window.removeEventListener(name, mark);
    };
  }, [keepalive]);
  // The served app reports its own natural height; the frame fits it inside the
  // host's bounds. One wire, one gate, one clamp (frame-resize.ts).
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onMessage = (event: MessageEvent) => { applyFrameResize(frameRef.current, event); };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      // A fresh URL is a fresh app: remount so no reported height carries over.
      key={url}
      ref={frameRef}
      title="Vendo app"
      src={url}
      sandbox={httpFrameSandbox(url)}
      style={{
        width: "100%",
        minHeight: "var(--vendo-app-frame-height, 320px)",
        maxHeight: FRAME_MAX_HEIGHT_CSS,
        border: 0,
      }}
    />
  );
}

/**
 * A SEALED bundle (FINAL SPEC v1) — the app's own document, served by
 * `GET /apps/:id/bundle/:hash` behind `default-src 'none'`.
 *
 * `allow-scripts` WITHOUT `allow-same-origin` is the enforcer: it gives the
 * frame an opaque origin, so the app runs in nobody's origin, reaches no host
 * storage or cookie, and — with the route's CSP — makes no request at all. Host
 * data reaches it through one door only, the postMessage bridge below, which
 * lands on the same guarded `onAction` a tree surface's press does.
 *
 * The seal is content, never brand: the tokens are posted in at boot, so the
 * same bytes follow whatever palette the host is wearing today.
 */
function BundleFrame({ appId, entry, onAction }: {
  appId: string;
  entry: string;
  onAction: NonNullable<AppFrameProps["onAction"]>;
}) {
  const { client, theme, fonts } = useVendoProvider();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const vars = useMemo(() => themeCssVariables(theme), [theme]);
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (applyFrameResize(frame, event)) return;
      // The handshake: a frame that has not booted has no listener yet, so the
      // tokens would land on nobody.
      if ((event.data as { vendo?: unknown; kind?: unknown } | null)?.kind === "booted" && isFromFrame(frame, event)) {
        sendFrameTheme(frame, vars, fonts);
        return;
      }
      const call = readFrameCall(frame, event);
      if (call === undefined) return;
      void onAction({ nodeId: call.id, action: call.ref, payload: call.args })
        .then((outcome) => replyToFrame(frame, call.id, outcome));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onAction, vars, fonts]);
  return (
    <iframe
      // The entry IS the content hash, so fresh bytes are a fresh frame.
      key={entry}
      ref={frameRef}
      title="Vendo app"
      src={client.apps.bundleUrl(appId, entry)}
      sandbox="allow-scripts"
      style={{
        width: "100%",
        minHeight: "var(--vendo-app-frame-height, 320px)",
        maxHeight: FRAME_MAX_HEIGHT_CSS,
        border: 0,
      }}
    />
  );
}

/** 08-ui §5; 06-apps §1 — render every app execution plane fail-soft. */
export function AppFrame({ surface, appId, components = {}, data, onAction = unavailableAction, onParked, onStateChange, keepalive }: AppFrameProps) {
  if (surface.kind === "http") {
    return <HttpFrame url={surface.url} keepalive={keepalive} />;
  }

  // A bundle is addressed by app: without one there is no url to open, and a
  // frame pointed at a guess is worse than an honest "unsupported" below.
  if (surface.kind === "bundle" && appId !== undefined) {
    return <BundleFrame appId={appId} entry={surface.entry} onAction={onAction} />;
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
        {...(appId === undefined ? {} : { appId })}
        components={components}
        data={data}
        onAction={onAction}
        onParked={onParked}
        onStateChange={onStateChange}
      />
    );
  }

  if (surface.kind === "failed") {
    return <ContainedNotice label="App unavailable" outcome="error">{surface.reason}</ContainedNotice>;
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
