import type { Integration } from "../seams/integrations";

export interface IntegrationsRailProps {
  integrations: Integration[];
  onConnectClick: () => void;
}

export function IntegrationsRail({ integrations, onConnectClick }: IntegrationsRailProps) {
  const connected = integrations.filter((i) => i.connected);
  return (
    <div className="fl-rail" aria-label="Connected tools">
      {connected.map((i) => (
        <span key={i.id} className="fl-rail-chip"><span className="fl-rail-dot" />{i.name}</span>
      ))}
      <button type="button" className="fl-rail-connect" onClick={onConnectClick}>+ Connect tools</button>
    </div>
  );
}
