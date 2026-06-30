import type { Integration } from "../seams/integrations";

export interface ConnectCardProps {
  integration: Integration;
  reason?: string;
  onConnect: () => void;
}

export function ConnectCard({ integration, reason, onConnect }: ConnectCardProps) {
  return (
    <div className="fl-connect" role="group" aria-label={`Connect ${integration.name}`}>
      <div style={{ fontWeight: 600 }}>Connect {integration.name}</div>
      {reason && <div style={{ fontSize: 12, margin: "6px 0 10px" }}>So I can {reason}.</div>}
      <button type="button" className="fl-btn fl-btn-primary" onClick={onConnect}>Connect {integration.name}</button>
    </div>
  );
}
