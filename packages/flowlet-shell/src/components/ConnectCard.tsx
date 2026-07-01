import type { Integration } from "../seams/integrations";
import { BrandIcon } from "./BrandIcon";

export interface ConnectCardProps {
  integration: Integration;
  reason?: string;
  onConnect: () => void;
}

export function ConnectCard({ integration, reason, onConnect }: ConnectCardProps) {
  return (
    <div className="fl-connect" role="group" aria-label={`Connect ${integration.name}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
        <BrandIcon id={integration.id} size={16} />
        Connect {integration.name}
      </div>
      {reason && <div style={{ fontSize: 12, margin: "6px 0 10px" }}>So I can {reason}.</div>}
      <button type="button" className="fl-btn fl-btn-primary" onClick={onConnect}>Connect {integration.name}</button>
    </div>
  );
}
