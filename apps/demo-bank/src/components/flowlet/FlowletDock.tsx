"use client";

/**
 * The docked Flowlet composer — a floating panel pinned to the bottom-right of
 * the Maple app. This is the script's "input bar at the bottom": the primary
 * on-stage surface. It renders the shared shell thread, so generated views show
 * up here as cards. When a rule fires, a confirmation banner drops in on top.
 */
import { AnimatePresence, motion } from "framer-motion";
import { FlowletThread } from "@flowlet/shell";
import type { FireEvent } from "./FlowletPoller";
import { resetDemo } from "./reset";

const SUGGESTIONS = [
  "What did I spend money on when I should've been asleep?",
  "What was that $87 DoorDash charge?",
];

function FireBanner({ fire, onDismiss }: { fire: FireEvent; onDismiss?: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
      style={{
        margin: 10,
        padding: "12px 14px",
        borderRadius: 12,
        background: "#0e3d2b",
        color: "#eafff4",
        boxShadow: "0 8px 24px rgba(14,61,43,.32)",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
      }}
    >
      <span style={{ fontSize: 18, lineHeight: "20px" }}>🔔</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          Rule fired → posted to #{fire.channel}
        </div>
        <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>
          {fire.merchant} ${fire.amountDollars.toFixed(2)} at {fire.time}
          {fire.slack.fallback ? " · (offline fallback)" : ""}
        </div>
      </div>
      {onDismiss ? (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{ background: "transparent", border: 0, color: "#eafff4", cursor: "pointer", fontSize: 16, opacity: 0.7 }}
        >
          ×
        </button>
      ) : null}
    </motion.div>
  );
}

export function FlowletDock({
  fire,
  onDismissFire,
}: {
  fire?: FireEvent | null;
  onDismissFire?: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        right: 24,
        bottom: 24,
        width: 440,
        height: "min(680px, calc(100vh - 48px))",
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
      <AnimatePresence>
        {fire ? <FireBanner key="fire" fire={fire} onDismiss={onDismissFire} /> : null}
      </AnimatePresence>
      <FlowletThread greeting="Ask Maple anything" suggestions={SUGGESTIONS} />
      <button
        onClick={() => void resetDemo()}
        title="Reset demo to a clean state"
        aria-label="Reset demo"
        style={{
          position: "absolute",
          top: 8,
          right: 10,
          zIndex: 2,
          background: "transparent",
          border: 0,
          cursor: "pointer",
          fontSize: 13,
          lineHeight: 1,
          color: "#b9bac0",
          padding: 4,
        }}
      >
        ↺
      </button>
    </div>
  );
}
