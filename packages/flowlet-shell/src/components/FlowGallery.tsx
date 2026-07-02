import { useEffect, useRef, useState } from "react";
import type { Flowlet } from "../seams/store";
import { relativeTimeLabel } from "../relative-time";

export interface FlowGalleryProps {
  flows: Flowlet[];
  onOpen: (flow: Flowlet) => void;
  /** Library management (ENG-183). Omit any to hide that affordance. */
  onRename?: (flow: Flowlet, name: string) => void;
  onPin?: (flow: Flowlet, pinned: boolean) => void;
  onDelete?: (flow: Flowlet) => void;
}

const byRecent = (a: Flowlet, b: Flowlet) => b.updatedAt - a.updatedAt;

/**
 * The saved-flowlet library: pinned cards first, then recent. Each card opens
 * its view; rename is inline, pin/delete sit in a hover action row. Dumb by
 * design — the host owns the store round-trips.
 */
export function FlowGallery({ flows, onOpen, onRename, onPin, onDelete }: FlowGalleryProps) {
  if (flows.length === 0) return null;
  const pinned = flows.filter((f) => f.pinned === true).sort(byRecent);
  const recent = flows.filter((f) => f.pinned !== true).sort(byRecent);
  const card = (flow: Flowlet) => (
    <FlowCard key={flow.id} flow={flow} onOpen={onOpen} onRename={onRename} onPin={onPin} onDelete={onDelete} />
  );
  return (
    <div className="fl-library">
      {pinned.length > 0 && (
        <>
          <div className="fl-library-label">Pinned</div>
          <div className="fl-gallery">{pinned.map(card)}</div>
        </>
      )}
      {recent.length > 0 && (
        <>
          {pinned.length > 0 && <div className="fl-library-label">Recent</div>}
          <div className="fl-gallery">{recent.map(card)}</div>
        </>
      )}
    </div>
  );
}

interface FlowCardProps {
  flow: Flowlet;
  onOpen: (flow: Flowlet) => void;
  onRename?: (flow: Flowlet, name: string) => void;
  onPin?: (flow: Flowlet, pinned: boolean) => void;
  onDelete?: (flow: Flowlet) => void;
}

function FlowCard({ flow, onOpen, onRename, onPin, onDelete }: FlowCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(flow.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const name = draft.trim();
    setEditing(false);
    if (name && name !== flow.name) onRename?.(flow, name);
    else setDraft(flow.name);
  };

  return (
    <div className={flow.pinned ? "fl-flowcard is-pinned" : "fl-flowcard"}>
      {editing ? (
        <input
          ref={inputRef}
          className="fl-flowcard-rename"
          aria-label="Rename view"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(flow.name);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button type="button" className="fl-flowcard-open" onClick={() => onOpen(flow)}>
          <span className="fl-flowcard-name">{flow.name}</span>
          {flow.prompt && flow.prompt !== flow.name && (
            <span className="fl-flowcard-prompt">{flow.prompt}</span>
          )}
          <span className="fl-flowcard-meta">updated {relativeTimeLabel(flow.updatedAt)}</span>
        </button>
      )}
      {(onPin ?? onRename ?? onDelete) && !editing && (
        <div className="fl-flowcard-actions">
          {onPin && (
            <button
              type="button"
              aria-label={flow.pinned ? "Unpin" : "Pin"}
              aria-pressed={flow.pinned === true}
              onClick={() => onPin(flow, flow.pinned !== true)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill={flow.pinned ? "currentColor" : "none"}
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 17v5" /><path d="M5 17h14l-1.5-4.5a2 2 0 0 1 0-1.3L19 7H5l1.5 4.2a2 2 0 0 1 0 1.3Z" />
              </svg>
            </button>
          )}
          {onRename && (
            <button
              type="button"
              aria-label="Rename"
              onClick={() => {
                setDraft(flow.name);
                setEditing(true);
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
          )}
          {onDelete && (
            <button type="button" aria-label="Delete" className="is-danger" onClick={() => onDelete(flow)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
