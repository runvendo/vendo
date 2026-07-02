import type { Integration } from "../seams/integrations";
import { FluidRipple } from "./FluidRipple";

export interface ConnectDockProps {
  integrations: Integration[];
  open: boolean;
  onToggle: () => void;
}

/**
 * The in-bar connect-tools entry (ENG-205, Yousef's pick): a compact tools
 * button beside attach with a connected-count badge, toggling the liquid
 * ConnectTray. Replaces the old rail pill above the thread. The Composio
 * flow behind it is unchanged.
 */
export function ConnectDock({ integrations, open, onToggle }: ConnectDockProps) {
  const connected = integrations.filter((i) => i.connected);

  return (
    // The badge lives OUTSIDE the ripple wrapper: fluidkit's Ripple clips its
    // children to the button's rounded box, and the badge overhangs that box
    // by design. The button's aria-label carries the count for AT.
    <span className="fl-dock">
      <FluidRipple className="fl-dock-ripple" color="color-mix(in srgb, currentColor 25%, transparent)">
        <button
          type="button"
          className="fl-icon-btn fl-dock-btn"
          aria-label={
            connected.length > 0
              ? `Connect tools (${connected.length} connected)`
              : "Connect tools"
          }
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={onToggle}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 7V2" /><path d="M15 7V2" />
            <path d="M6 7h12v4a6 6 0 0 1-12 0Z" /><path d="M12 17v5" />
          </svg>
        </button>
      </FluidRipple>
      {connected.length > 0 && (
        <span className="fl-dock-badge" aria-hidden="true">{connected.length}</span>
      )}
    </span>
  );
}
