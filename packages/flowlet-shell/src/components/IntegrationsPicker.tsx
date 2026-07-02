import { useEffect, useRef, useState } from "react";
import type { Integration } from "../seams/integrations";
import { BrandIcon } from "./BrandIcon";
import { FluidThinking } from "./FluidThinking";

export interface IntegrationsPickerProps {
  integrations: Integration[];
  /** May return the connect flow's promise — the row shows a live connecting
   *  state until it settles and the refreshed list arrives. */
  onConnect: (id: string) => void | Promise<unknown>;
  onDisconnect: (id: string) => void;
  onClose: () => void;
}

export function IntegrationsPicker({ integrations, onConnect, onDisconnect, onClose }: IntegrationsPickerProps) {
  const [query, setQuery] = useState("");
  // Rows with an OAuth flow in flight, and rows whose flip to connected was
  // OBSERVED here (those get the one-shot green celebration; rows that mount
  // already-connected never do).
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [justConnected, setJustConnected] = useState<ReadonlySet<string>>(new Set());
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // Celebrate every OBSERVED disconnected→connected transition (tracked via a
  // per-id snapshot, so fresh mounts never celebrate). Deliberately not tied
  // to `pending`: whatever order the un-pend timer and the refreshed-list
  // commit land in, a real flip always blooms.
  const prevConnected = useRef<Map<string, boolean>>(new Map());
  useEffect(() => {
    const landed: string[] = [];
    for (const i of integrations) {
      if (prevConnected.current.get(i.id) === false && i.connected) landed.push(i.id);
      prevConnected.current.set(i.id, i.connected);
    }
    if (landed.length === 0) return;
    setJustConnected((prev) => new Set([...prev, ...landed]));
    setPending((prev) => {
      if (!landed.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of landed) next.delete(id);
      return next;
    });
  }, [integrations]);

  const connect = (id: string) => {
    setPending((prev) => new Set([...prev, id]));
    void Promise.resolve(onConnect(id))
      .catch(() => undefined)
      .then(() => {
        // Failure fallback: return the row to the + once the flow settles.
        // Successful flips are handled independently by the transition effect
        // above, so this timer can't lose a celebration whatever order the
        // refreshed list commits in.
        setTimeout(() => {
          if (!alive.current) return;
          setPending((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }, 120);
      });
  };

  const shown = integrations.filter((i) => i.name.toLowerCase().includes(query.toLowerCase()));
  const connected = shown.filter((i) => i.connected);
  const available = shown.filter((i) => !i.connected);

  const row = (i: Integration) => {
    const classes = [
      "fl-picker-item",
      i.connected ? "is-connected" : "",
      // Celebration only while the row is still connected — a disconnect with
      // the tray open must not leave the bloom on the returned + row.
      i.connected && justConnected.has(i.id) ? "is-just-connected" : "",
    ].filter(Boolean).join(" ");
    return (
      <div key={i.id} className={classes}>
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
          ) : pending.has(i.id) ? (
            <span className="fl-picker-connecting">
              <FluidThinking label={`Connecting ${i.name}`} size={5} spread={15} />
            </span>
          ) : (
            <button
              type="button"
              className="fl-picker-add"
              aria-label={`Connect ${i.name}`}
              onClick={() => connect(i.id)}
            >
              +
            </button>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="fl-picker" role="dialog" aria-label="Integrations">
      <div className="fl-picker-toprow">
        <input
          className="fl-picker-search"
          placeholder="Search integrations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onClose()}
          aria-label="Search integrations"
          autoFocus
        />
        <button type="button" className="fl-picker-close" aria-label="Close" onClick={onClose}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
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
