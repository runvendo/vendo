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
}

const unavailableAction = async (): Promise<ToolOutcome> => ({
  status: "error",
  error: { code: "not-implemented", message: "No app action handler was provided." },
});

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
  const booted = useRef(false);
  const vars = useMemo(() => themeCssVariables(theme), [theme]);
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (applyFrameResize(frame, event)) return;
      // The handshake: a frame that has not booted has no listener yet, so the
      // tokens would land on nobody. Stamped like every other branch of this
      // bridge — a frame speaking some other protocol that happens to use the
      // same `kind` key is not this one.
      const message = event.data as { vendo?: unknown; kind?: unknown } | null;
      if (message?.vendo === true && message.kind === "booted" && isFromFrame(frame, event)) {
        booted.current = true;
        sendFrameTheme(frame, vars, fonts);
        return;
      }
      const call = readFrameCall(frame, event);
      if (call === undefined) return;
      void onAction({ nodeId: call.id, action: call.ref, payload: call.args }).then(
        (outcome) => replyToFrame(frame, call.id, outcome),
        // A REFUSAL is still an answer. `callHost` inside the seal has no
        // timeout of its own, so a call left unanswered leaves whatever asked
        // for it loading for the life of the page.
        (reason: unknown) => replyToFrame(frame, call.id, {
          status: "error",
          error: {
            code: "execution",
            message: reason instanceof Error ? reason.message : String(reason),
          },
        }),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onAction, vars, fonts]);
  // A palette or a brand face that moves AFTER the handshake gets no second
  // `booted` to ride in on, so the seal would wear the theme it mounted under
  // for the rest of the page's life.
  useEffect(() => {
    if (booted.current) sendFrameTheme(frameRef.current, vars, fonts);
  }, [vars, fonts]);
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
export function AppFrame({ surface, appId, components = {}, data, onAction = unavailableAction, onParked }: AppFrameProps) {
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
