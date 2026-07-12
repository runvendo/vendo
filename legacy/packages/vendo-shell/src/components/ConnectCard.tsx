import type { Integration } from "../seams/integrations";
import { BrandIcon } from "./BrandIcon";

export interface ConnectCardProps {
  integration: Integration;
  reason?: string;
  onConnect: () => void;
}

/** The template supplies "So I can …"; the reason field's canonical examples
 *  are purpose clauses ("to read the receipt"), so a leading to-infinitive
 *  must fold into the sentence, never concatenate ("So I can To send …"). */
function composeReason(reason: string): string {
  return reason.replace(/^\s*to\s+/i, "").trimEnd().replace(/\.$/, "");
}

export function ConnectCard({ integration, reason, onConnect }: ConnectCardProps) {
  return (
    <div className="fl-connect" role="group" aria-label={`Connect ${integration.name}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
        <BrandIcon id={integration.id} size={16} />
        Connect {integration.name}
      </div>
      {reason && <div style={{ fontSize: 12, margin: "6px 0 10px" }}>So I can {composeReason(reason)}.</div>}
      <button type="button" className="fl-btn fl-btn-primary" onClick={onConnect}>Connect {integration.name}</button>
    </div>
  );
}
