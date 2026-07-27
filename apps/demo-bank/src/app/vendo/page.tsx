"use client";

import { VendoActivities, VendoThread } from "@vendoai/ui/chrome";
import { VendoStage } from "@vendoai/ui/voice";
import { VendoRoot } from "@/components/vendo/VendoRoot";
import { useTryThisChips } from "@/components/vendo/use-try-this-chips";
import { mapleScenarios } from "@/vendo/scenarios";

export default function VendoTabPage() {
  // "Try this" chips (demo-hygiene): pre-generated prompts as pill chips one
  // tier below the scenario cards. An empty cache keeps the ORIGINAL
  // mapleScenarios reference (and no extra render, see useTryThisChips), so
  // the first-visit landing contract — one render, cards only — holds.
  const chips = useTryThisChips();
  const suggestions = chips.length === 0 ? mapleScenarios : [...mapleScenarios, ...chips];
  return (
    <div
      style={{
        height: "calc(100dvh - 112px)",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
      }}
    >
      <VendoRoot>
        {/* ENG-286 → shelf: the hand-rolled MapleApprovals inbox is now the
            shipped VendoActivities piece — pending approvals (including calls
            arriving through the MCP door) plus the recent agent-activity feed.
            flexShrink 0: a natural-height block; when space runs out the
            column scrolls instead of squeezing content into overlap. */}
        <div className="pb-4" style={{ flexShrink: 0 }}>
          <VendoActivities />
        </div>
        {/* demo-refresh Part 6 — the scenario ladder as starter cards on the
            empty landing (same set the overlay's thread shows).
            discoverability="quiet" matches the overlay's MapleThread: the
            fire-once greeting-as-tutorial would otherwise replace the cards on
            the FIRST-ever visit (and burn the flag), so the funnel's opening
            beat showed generic chips until a reload.
            The 420px floor keeps the thread usable at short viewports: an
            in-thread approval card + composer always fit, so consent is
            clickable instead of being flex-squeezed under the sibling
            surfaces (the column above scrolls when the floor doesn't fit). */}
        <div style={{ flex: "1 0 auto", minHeight: 420, display: "flex", flexDirection: "column" }}>
          <VendoThread suggestions={suggestions} discoverability="quiet" />
        </div>
        {/* The docked voice surface keeps a fixed slot below the thread — it
            never shrinks into a sliver whose chrome paints over the thread
            (the stage also clips to its box; see .fl-voice-root). */}
        <div style={{ flex: "0 0 auto", height: 260 }}>
          <VendoStage />
        </div>
      </VendoRoot>
    </div>
  );
}
