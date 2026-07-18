import type { Json, ToolOutcome, UIPayload } from "@vendoai/core";
import { useEffect, type ReactNode } from "react";
import { useVendoContext } from "../context.js";
import { useApp } from "../hooks/use-app.js";
import { useSlotApp } from "../hooks/use-slot-app.js";
import { FluidReveal } from "../tree/fluid-reveal.js";
import { AppFrame, PinMount } from "../tree/frames.js";
import { ChromeRoot } from "./chrome-root.js";
import { openVendoOverlay } from "./overlay-registry.js";
import { openVendoPalette } from "./palette-hotkey.js";

function developmentMode(): boolean {
  return typeof process !== "undefined" && process.env?.NODE_ENV === "development";
}

/** The faint skeleton behind the ghost/empty states — decorative only. */
function GhostSkeleton() {
  return (
    <span className="fl-slot-skel" aria-hidden="true">
      <span className="fl-skel-line" style={{ width: "54%" }} />
      <span className="fl-skel-line" style={{ width: "78%" }} />
      <span className="fl-skel-line" style={{ width: "42%" }} />
      <span className="fl-skel-bars">
        <span style={{ height: "42%" }} />
        <span style={{ height: "68%" }} />
        <span style={{ height: "52%" }} />
        <span style={{ height: "84%" }} />
        <span style={{ height: "62%" }} />
      </span>
    </span>
  );
}

function SlotGhost({ label, detail, loading = false }: { label: string; detail?: string; loading?: boolean }) {
  return (
    <div className="fl-slot-ghost" role={loading ? "status" : undefined} aria-live={loading ? "polite" : undefined}>
      <GhostSkeleton />
      <span className="fl-slot-cta">
        <span className="fl-slot-cta-label">{label}</span>
        {detail ? <small>{detail}</small> : null}
      </span>
    </div>
  );
}

function MountedApp({ appId }: { appId: string }) {
  const { client, components } = useVendoContext();
  const { surface } = useApp(appId);
  if (!surface) return <SlotGhost label="Loading app…" loading />;
  return <AppFrame key={appId} surface={surface} components={components} onAction={({ action, payload }) => client.apps.call(appId, action, payload ?? {})} />;
}

/** A generated view pinned into a slot (08-ui §4 — "or a pinned component").
 *  Unlike an app (a whole document), a pin is a single `vendo-genui/v1` tree the
 *  user authored and pinned in place; it mounts through the same tree renderer +
 *  error boundary, falling back to the host's original markup if it throws. */
export interface VendoSlotPin {
  /** The pinned generated view (a `vendo-genui/v1` tree payload). */
  payload: UIPayload;
  /** Live data overriding the tree's embedded data model (08-ui §5). */
  data?: Record<string, Json>;
  /** Action dispatch for the pinned component; defaults to the tree renderer's
   *  fail-soft no-op when a pin carries no live handler. */
  onAction?(req: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome>;
}

/** 08-ui §4; 06-apps §8 — inline mount that never sacrifices host fallback content.
 *
 *  Three states:
 *  - empty: no `appId`, no `pin`, no `children` → the ghost with a REAL CTA button
 *    that opens the authoring surface (`onAuthor`, else the mounted ⌘K palette);
 *  - app: `appId` → the whole app document mounts (via the single-app transport);
 *  - pinned component: `pin` → the authored `vendo-genui/v1` view mounts in place.
 *
 *  In both filled states the swap morphs through the ENG-205 render slot, using
 *  the host's own markup as the exit frame, and the PinMount error boundary keeps
 *  the original `children` as the visible recovery path (06-apps §8). Without any
 *  of the three, the children render UNTOUCHED (no wrapper — hosts may inline
 *  slots anywhere). */
export function VendoSlot({ id, appId: appIdProp, pin, onAuthor, remix = false, remixPrompt, children }: {
  id: string;
  appId?: string;
  pin?: VendoSlotPin;
  /** Invoked when the empty-state CTA is activated — the seam to open a thread
   *  or palette to author the view. Defaults to opening a mounted VendoPalette. */
  onAuthor?(slotId: string): void;
  /** Remix folds into Slot as a flag (ui-usage-dx §2): show the hover Remix
   *  affordance on the slot's content; activating it opens the mounted overlay
   *  preloaded with the remix prompt. The slot id should match a registered
   *  (remixable) host component so the agent can fork the captured source —
   *  init/doctor verify the flag against catalog registrations. */
  remix?: boolean;
  /** Override for the remix request; defaults to a prompt naming the slot's
   *  registered component. */
  remixPrompt?: string;
  children?: ReactNode;
}) {
  const { components } = useVendoContext();
  // Self-discovery (ui-usage-dx §2): with no explicit `appId`/`pin`, the slot
  // resolves its own pinned app — hosts never write the polling dance.
  const discovery = useSlotApp(id, { enabled: appIdProp === undefined && pin === undefined });
  const appId = appIdProp ?? (pin === undefined ? discovery.appId : undefined);

  // Dev rail: the remix flow forks the component captured under this slot's
  // registered name — an unregistered name means the agent has nothing to fork.
  // (The client can't see catalog `remixable` flags; init verifies those.)
  useEffect(() => {
    if (!remix || !developmentMode() || components[id] !== undefined) return;
    console.warn(
      `[vendo] VendoSlot "${id}" sets remix, but no host component is registered under that name — register it (marked remixable) so the agent can capture and fork it.`,
    );
  }, [remix, id, components]);

  const author = () => {
    if (onAuthor) {
      onAuthor(id);
      return;
    }
    openVendoPalette();
  };

  const startRemix = () => {
    const prompt = remixPrompt
      ?? `Remix the ${id} component — I want to make this view my own.`;
    const opened = openVendoOverlay({ prompt, send: true });
    if (!opened && developmentMode()) {
      console.warn(`[vendo] VendoSlot "${id}": remix opens the conversation surface — mount a VendoOverlay for it to land in.`);
    }
  };

  const remixButton = remix ? (
    <button type="button" className="fl-slot-remix" aria-label={`Remix ${id} with Vendo`} onClick={startRemix}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z" />
      </svg>
      Remix
    </button>
  ) : null;

  if (!appId && !pin) {
    if (children !== undefined) {
      if (remixButton === null) return <>{children}</>;
      // The affordance needs a positioned boundary over the host's own markup;
      // the inline wrapper stays layout-neutral (the ChromeRoot child is an
      // empty block carrying only the absolutely-positioned button).
      return (
        <div data-vendo-slot={id} style={{ position: "relative", height: "100%" }}>
          <ChromeRoot automaticPolicyNotice={false}>{remixButton}</ChromeRoot>
          {children}
        </div>
      );
    }
    return (
      <ChromeRoot>
        <div className="fl-slot" data-vendo-slot={id}>
          <button
            type="button"
            className="fl-slot-ghost fl-slot-ghost-cta"
            aria-label="Design a view — describe it, I'll render it"
            onClick={author}
          >
            <GhostSkeleton />
            <span className="fl-slot-cta">
              <span className="fl-slot-cta-label">Design a view</span>
              <small>describe it, I'll render it</small>
            </span>
          </button>
        </div>
      </ChromeRoot>
    );
  }

  const Fallback = () => <>{children}</>;
  const mounted = appId
    ? <MountedApp appId={appId} />
    : <AppFrame surface={{ kind: "tree", payload: pin!.payload }} components={components} data={pin!.data} onAction={pin!.onAction} />;
  return (
    <ChromeRoot>
      <div className="fl-slot" data-vendo-slot={id}>
        {remixButton}
        <div className="fl-slot-filled">
          <FluidReveal stateKey={appId ? `app:${appId}` : `pin:${id}`} initialExit={children}>
            <PinMount slot={id} fallback={Fallback}>{mounted}</PinMount>
          </FluidReveal>
        </div>
      </div>
    </ChromeRoot>
  );
}
