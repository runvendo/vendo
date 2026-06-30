import { useEffect, useRef, useState } from "react";
import type { UINode } from "@flowlet/core";
import { useFlowletChat } from "@flowlet/react";
import { UINodeView } from "../components/UINodeView";
import { FlowletThread } from "../FlowletThread";
import { useFocusTrap } from "../use-focus-trap";

export interface FlowletSlotProps {
  flowletId: string;
  /** Seed the slot with a node (e.g. SSR/fixture). localStorage wins otherwise. */
  savedNode?: UINode;
  emptyLabel?: string;
}

const storageKey = (id: string) => `flowlet-slot:${id}`;

/**
 * A generative card embedded in a host surface. Empty, it shows a ghost preview
 * inviting a click; clicking opens an overlay chat. The view you pin from the
 * thread becomes the card's resting state (persisted to localStorage), with an
 * overflow menu to edit (reopen the chat) or remove (back to blank).
 */
export function FlowletSlot({ flowletId, savedNode, emptyLabel = "Design a view" }: FlowletSlotProps) {
  const [pinned, setPinned] = useState<UINode | null>(savedNode ?? null);
  const [designing, setDesigning] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { setMessages } = useFlowletChat();
  useFocusTrap(designing, panelRef);

  // Hydrate from localStorage after mount so SSR and first client render agree
  // (both start empty), then the saved view fills in.
  useEffect(() => {
    if (savedNode) return;
    try {
      const raw = window.localStorage.getItem(storageKey(flowletId));
      if (raw) setPinned(JSON.parse(raw) as UINode);
    } catch {
      /* malformed or blocked storage — treat as empty */
    }
  }, [flowletId, savedNode]);

  // Close the overflow menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const persist = (node: UINode | null) => {
    try {
      if (node) window.localStorage.setItem(storageKey(flowletId), JSON.stringify(node));
      else window.localStorage.removeItem(storageKey(flowletId));
    } catch {
      /* storage unavailable — state stays in memory */
    }
  };

  const pin = (node: UINode) => { setPinned(node); persist(node); setDesigning(false); };
  const edit = () => { setMenuOpen(false); setDesigning(true); };
  const remove = () => {
    setPinned(null);
    persist(null);
    setMenuOpen(false);
    void setMessages([]); // start a fresh conversation next time
  };

  return (
    <div className="fl-slot" data-flowlet-id={flowletId}>
      {pinned ? (
        <div className="fl-slot-filled">
          <UINodeView node={pinned} />
          <div className="fl-slot-menu-wrap" ref={menuRef}>
            <button
              type="button"
              className="fl-slot-menu-btn"
              aria-label="Flowlet options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
              </svg>
            </button>
            {menuOpen && (
              <div className="fl-slot-menu" role="menu">
                <button type="button" role="menuitem" onClick={edit}>Edit view</button>
                <button type="button" role="menuitem" className="is-danger" onClick={remove}>Remove</button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <button type="button" className="fl-slot-ghost" onClick={() => setDesigning(true)}>
          <div className="fl-slot-skel" aria-hidden>
            <span className="fl-skel-line" style={{ width: "55%" }} />
            <span className="fl-skel-line" style={{ width: "34%" }} />
            <div className="fl-skel-bars">
              <span style={{ height: "55%" }} />
              <span style={{ height: "82%" }} />
              <span style={{ height: "44%" }} />
              <span style={{ height: "92%" }} />
              <span style={{ height: "60%" }} />
            </div>
          </div>
          <span className="fl-slot-cta">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
            <span className="fl-slot-cta-label">{emptyLabel}</span>
            <small>describe it, I&apos;ll render it</small>
          </span>
        </button>
      )}
      {designing && (
        <>
          <div className="fl-overlay-scrim" onClick={() => setDesigning(false)} />
          <div
            className="fl-overlay-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Design flowlet"
            tabIndex={-1}
            ref={panelRef}
            onKeyDown={(e) => { if (e.key === "Escape") setDesigning(false); }}
          >
            <FlowletThread greeting="What can Vendo build here?" onPin={pin} />
          </div>
        </>
      )}
    </div>
  );
}
