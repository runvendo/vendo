/**
 * Surface #3 — the generative slot embedded in the inbox, above the message
 * list. Empty, it shows a ghost preview inviting a click; the agent builds a
 * view in an overlay and the user pins it in place (persisted per slot id).
 * Isolated thread ("gmail-slot") so it never crosses wires with the overlay
 * or the Vendo page.
 */
import React from "react";
import { FlowletSlot } from "@flowlet/shell";
import { FlowletRoot } from "./FlowletRoot";

export function InboxSlot() {
  return (
    // Banner-height slot (the shell's --fl-slot-min-h knob): polite when
    // empty, still roomy enough for a pinned view.
    <div
      style={{ padding: "8px 12px 4px", background: "#fff", "--fl-slot-min-h": "200px" }}
      aria-label="Custom view"
    >
      <FlowletRoot threadId="gmail-slot">
        <FlowletSlot
          flowletId="inbox-top"
          emptyLabel="Design a view for this inbox"
          greeting="What should live at the top of your inbox?"
          suggestions={[
            "My unread emails at a glance",
            "A chart of who emails me most",
            "My travel plans pulled from my inbox",
          ]}
        />
      </FlowletRoot>
    </div>
  );
}
