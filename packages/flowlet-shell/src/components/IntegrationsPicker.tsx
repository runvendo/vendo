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
  const connected = shown.filter((i) => i.connected);
  const available = shown.filter((i) => !i.connected);

  const row = (i: Integration) => (
    <div key={i.id} className={i.connected ? "fl-picker-item is-connected" : "fl-picker-item"}>
      <span className="fl-picker-ic">
        <BrandIcon id={i.id} size={15} />
      </span>
      <span className="fl-picker-nm">{i.name}</span>
      <span className="fl-picker-status">
        {i.connected ? (
          <button
            type="button"
            className="fl-picker-on"
            aria-label={`Disconnect ${i.name}`}
            onClick={() => onDisconnect(i.id)}
            style={{ border: 0, padding: 0, cursor: "pointer" }}
          />
        ) : (
          <button
            type="button"
            className="fl-picker-add"
            aria-label={`Connect ${i.name}`}
            onClick={() => onConnect(i.id)}
          >
            +
          </button>
        )}
      </span>
    </div>
  );

  return (
    <div className="fl-picker" role="dialog" aria-label="Integrations">
      <div className="fl-picker-head">
        <span className="fl-picker-title">Connect tools</span>
        <button type="button" className="fl-picker-close" aria-label="Close" onClick={onClose}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <input
        className="fl-picker-search"
        placeholder="Search integrations…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        aria-label="Search integrations"
        autoFocus
      />
      {connected.length > 0 && (
        <>
          <div className="fl-picker-group">Connected</div>
          <div className="fl-picker-grid">{connected.map(row)}</div>
        </>
      )}
      {available.length > 0 && (
        <>
          <div className="fl-picker-group">Available</div>
          <div className="fl-picker-grid">{available.map(row)}</div>
        </>
      )}
    </div>
  );
}
