import { useState } from "react";
import type { UINode } from "@flowlet/core";
import { UINodeView } from "../components/UINodeView";
import { FlowletThread } from "../FlowletThread";

export interface FlowletSlotProps {
  flowletId: string;
  savedNode?: UINode;
  emptyLabel?: string;
}

export function FlowletSlot({ flowletId, savedNode, emptyLabel = "Design a flowlet here" }: FlowletSlotProps) {
  const [designing, setDesigning] = useState(false);

  return (
    <div className="fl-slot" data-flowlet-id={flowletId}>
      {savedNode ? (
        <UINodeView node={savedNode} />
      ) : (
        <button type="button" className="fl-slot-empty" onClick={() => setDesigning(true)}>
          <span aria-hidden="true">✦</span>
          <span>{emptyLabel}</span>
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
            onKeyDown={(e) => { if (e.key === "Escape") setDesigning(false); }}
          >
            <FlowletThread greeting="What should this flowlet show?" />
          </div>
        </>
      )}
    </div>
  );
}
