import type { ReactNode } from "react";
import { useVendoContext } from "../context.js";
import { useApp } from "../hooks/use-app.js";
import { FluidReveal } from "../tree/fluid-reveal.js";
import { AppFrame, PinMount } from "../tree/frames.js";
import { ChromeRoot } from "./chrome-root.js";

function SlotGhost({ label, detail, loading = false }: { label: string; detail?: string; loading?: boolean }) {
  return (
    <div className="fl-slot-ghost" role={loading ? "status" : undefined} aria-live={loading ? "polite" : undefined}>
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

/** 08-ui §4; 06-apps §8 — inline mount that never sacrifices host fallback content.
 *  Without an app the children render UNTOUCHED (no wrapper — hosts may inline
 *  slots anywhere). When an app takes the slot, the swap morphs through the
 *  ENG-205 render slot, using the host's own markup as the exit frame. */
export function VendoSlot({ id, appId, children }: { id: string; appId?: string; children?: ReactNode }) {
  if (!appId) {
    if (children !== undefined) return <>{children}</>;
    return (
      <ChromeRoot>
        <div className="fl-slot" data-vendo-slot={id}>
          <SlotGhost label="Design a view" detail="describe it, I'll render it" />
        </div>
      </ChromeRoot>
    );
  }
  const Fallback = () => <>{children}</>;
  return (
    <ChromeRoot>
      <div className="fl-slot" data-vendo-slot={id}>
        <div className="fl-slot-filled">
          <FluidReveal stateKey={`app:${appId}`} initialExit={children}>
            <PinMount slot={id} fallback={Fallback}><MountedApp appId={appId} /></PinMount>
          </FluidReveal>
        </div>
      </div>
    </ChromeRoot>
  );
}
