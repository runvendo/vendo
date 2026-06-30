import { useState } from "react";
import type { Integration } from "../seams/integrations";
import { BrandIcon } from "./BrandIcon";

export interface IntegrationsPickerProps {
  integrations: Integration[];
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onClose: () => void;
}

export function IntegrationsPicker({ integrations, onConnect, onDisconnect, onClose }: IntegrationsPickerProps) {
  const [query, setQuery] = useState("");
  const shown = integrations.filter((i) => i.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="fl-picker" role="dialog" aria-label="Integrations">
      <input
        className="fl-picker-item"
        placeholder="search integrations…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search integrations"
      />
      {shown.map((i) => (
        <div key={i.id} className="fl-picker-item">
          <BrandIcon id={i.id} size={15} className="fl-rail-icon" />
          <span>{i.name}</span>
          {i.connected ? (
            <button type="button" className="fl-btn" style={{ marginLeft: "auto" }} onClick={() => onDisconnect(i.id)}>Disconnect</button>
          ) : (
            <button type="button" className="fl-btn fl-btn-primary" style={{ marginLeft: "auto" }} onClick={() => onConnect(i.id)}>Connect</button>
          )}
        </div>
      ))}
      <button type="button" className="fl-btn" onClick={onClose}>Close</button>
    </div>
  );
}
