import type { Integration } from "../seams/integrations";
import { BrandIcon } from "./BrandIcon";

export interface IntegrationsRailProps {
  integrations: Integration[];
  onConnectClick: () => void;
}

export function IntegrationsRail({ integrations, onConnectClick }: IntegrationsRailProps) {
  const connected = integrations.filter((i) => i.connected);
  return (
    <div className="fl-rail" aria-label="Connected tools">
      {connected.map((i) => (
        <span key={i.id} className="fl-rail-chip is-connected">
          <BrandIcon id={i.id} size={14} className="fl-rail-icon" />
          {i.name}
        </span>
      ))}
      <button type="button" className="fl-rail-connect" onClick={onConnectClick}>+ Connect tools</button>
    </div>
  );
}
