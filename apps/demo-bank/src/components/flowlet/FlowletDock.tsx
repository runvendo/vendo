"use client";

/**
 * The docked Flowlet composer — a floating panel pinned to the bottom-right of
 * the Maple app. This is the script's "input bar at the bottom": the primary
 * on-stage surface. It renders the shared shell thread, so generated views show
 * up here as cards.
 *
 * Phase 0: always-open panel (proves streaming). Phase 1 adds collapse/expand
 * and the home inline-card feed.
 */
import { FlowletThread } from "@flowlet/shell";

const SUGGESTIONS = [
  "What did I spend money on when I should've been asleep?",
  "What was that $87 DoorDash charge?",
];

export function FlowletDock() {
  return (
    <div
      style={{
        position: "fixed",
        right: 24,
        bottom: 24,
        width: 420,
        height: 560,
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        borderRadius: 16,
        border: "1px solid #e9e9e5",
        background: "#fff",
        boxShadow: "0 18px 50px rgba(27,30,37,.16)",
      }}
    >
      <FlowletThread greeting="Ask Maple anything" suggestions={SUGGESTIONS} />
    </div>
  );
}
