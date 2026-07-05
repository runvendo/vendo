import { useEffect, useState } from "react";
import { LiquidMenu } from "fluidkit";
import type { UINode } from "@flowlet/core";
import { useFlowletChat } from "@flowlet/react";
import { useShell } from "../context";
import { UINodeView } from "../components/UINodeView";
import { OverlayPanel } from "../components/OverlayPanel";
import { FlowletThread } from "../FlowletThread";

export interface FlowletSlotProps {
  flowletId: string;
  /** Seed the slot with a node (e.g. SSR/fixture). localStorage wins otherwise. */
  savedNode?: UINode;
  emptyLabel?: string;
  /** Design-overlay greeting + suggestions — same shape as the Cmd+K overlay so
   *  the design experience matches it (plus the pin-to-card footer). */
  greeting?: string;
  suggestions?: string[];
}

const storageKey = (id: string) => `flowlet-slot:${id}`;

/**
 * A generative card embedded in a host surface. Empty, it shows a ghost preview
 * inviting a click; clicking opens an overlay chat. The view you pin from the
 * thread becomes the card's resting state (persisted to localStorage), with an
 * overflow menu to edit (reopen the chat) or remove (back to blank).
 */
export function FlowletSlot({
  flowletId,
  savedNode,
  emptyLabel = "Design a view",
  greeting,
  suggestions = [],
}: FlowletSlotProps) {
  const { productName } = useShell();
  // Brand-neutral default: the shell ships no product names of its own; hosts
  // brand the copy via the `productName` seam (or an explicit `greeting`).
  const slotGreeting =
    greeting ?? (productName ? `What can ${productName} build here?` : "What can I build here?");
  const [pinned, setPinned] = useState<UINode | null>(savedNode ?? null);
  const [designing, setDesigning] = useState(false);
  const { setMessages } = useFlowletChat();

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
  const persist = (node: UINode | null) => {
    try {
      if (node) window.localStorage.setItem(storageKey(flowletId), JSON.stringify(node));
      else window.localStorage.removeItem(storageKey(flowletId));
    } catch {
      /* storage unavailable — state stays in memory */
    }
  };

  const pin = (node: UINode) => { setPinned(node); persist(node); setDesigning(false); };
  const edit = () => setDesigning(true);
  const remove = () => {
    setPinned(null);
    persist(null);
    void setMessages([]); // start a fresh conversation next time
  };

  return (
    <div className="fl-slot" data-flowlet-id={flowletId}>
      {pinned ? (
        <div className="fl-slot-filled">
          <UINodeView node={pinned} />
          <div className="fl-slot-menu-wrap">
            {/* fluidkit LiquidMenu owns open state, outside-click, Escape, and
                the full ARIA menu keyboard pattern the hand-rolled version
                approximated; it pours from the trigger and themes from the
                brand via FluidThemeProvider. */}
            <LiquidMenu
              align="end"
              trigger={
                <button type="button" className="fl-slot-menu-btn" aria-label="Flowlet options">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
                  </svg>
                </button>
              }
              items={[
                { label: "Edit view", onSelect: edit },
                { type: "separator" },
                { label: <span className="fl-menu-danger">Remove</span>, onSelect: remove },
              ]}
            />
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
      <OverlayPanel open={designing} onClose={() => setDesigning(false)} ariaLabel="Design view">
        <FlowletThread greeting={slotGreeting} suggestions={suggestions} onPin={pin} />
      </OverlayPanel>
    </div>
  );
}
