import type { ReactNode } from "react";
import { useVendoContext } from "../context.js";
import { useApp } from "../hooks/use-app.js";
import { AppFrame, PinMount } from "../tree/frames.js";
import { ChromeRoot } from "./chrome-root.js";

function MountedApp({ appId }: { appId: string }) {
  const { client, components } = useVendoContext();
  const { surface } = useApp(appId);
  if (!surface) return <div className="fl-slot-empty" role="status" aria-live="polite">Loading app…</div>;
  return <AppFrame key={appId} surface={surface} components={components} onAction={({ action, payload }) => client.apps.call(appId, action, payload ?? {})} />;
}

/** 08-ui §4; 06-apps §8 — inline mount that never sacrifices host fallback content. */
export function VendoSlot({ id, appId, children }: { id: string; appId?: string; children?: ReactNode }) {
  if (!appId) return <>{children}</>;
  const Fallback = () => <>{children}</>;
  return (
    <ChromeRoot>
      <div className="fl-slot" data-vendo-slot={id}>
        <div className="fl-slot-filled">
          <PinMount slot={id} fallback={Fallback}><MountedApp appId={appId} /></PinMount>
        </div>
      </div>
    </ChromeRoot>
  );
}
