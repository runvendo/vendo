import type { Integration } from "../seams/integrations";
import { BrandIcon } from "./BrandIcon";
import { FluidRipple } from "./FluidRipple";

export interface ConnectDockProps {
  /** A: compact tools button with a count badge. B: brand-coin cluster. */
  variant: "icon" | "cluster";
  integrations: Integration[];
  open: boolean;
  onToggle: () => void;
}

const MAX_COINS = 3;

/**
 * The in-bar connect affordance (ENG-205 exploration). Replaces the rail's
 * "+ Connect tools" pill: lives inside the composer row and toggles the
 * integrations tray / bar morph. The Composio flow behind it is unchanged.
 */
export function ConnectDock({ variant, integrations, open, onToggle }: ConnectDockProps) {
  const connected = integrations.filter((i) => i.connected);

  const face =
    variant === "icon" ? (
      <>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 7V2" /><path d="M15 7V2" />
          <path d="M6 7h12v4a6 6 0 0 1-12 0Z" /><path d="M12 17v5" />
        </svg>
        {connected.length > 0 && <span className="fl-dock-badge">{connected.length}</span>}
      </>
    ) : connected.length === 0 ? (
      <span className="fl-dock-coin-add" aria-hidden="true">+</span>
    ) : (
      <>
        <span className="fl-dock-coins" aria-hidden="true">
          {connected.slice(0, MAX_COINS).map((i) => (
            <span key={i.id} className="fl-dock-coin">
              <BrandIcon id={i.id} size={13} />
            </span>
          ))}
        </span>
        {connected.length > MAX_COINS && (
          <span className="fl-dock-more">+{connected.length - MAX_COINS}</span>
        )}
      </>
    );

  return (
    <FluidRipple className="fl-dock" color="color-mix(in srgb, currentColor 25%, transparent)">
      <button
        type="button"
        className={`fl-icon-btn fl-dock-btn fl-dock-${variant}`}
        aria-label={
          connected.length > 0
            ? `Connect tools (${connected.length} connected)`
            : "Connect tools"
        }
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={onToggle}
      >
        {face}
      </button>
    </FluidRipple>
  );
}
