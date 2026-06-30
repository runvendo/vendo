"use client";

/**
 * The automation alert, self-standing. When a rule fires while the overlay is
 * closed, this graphite-glass toast slides in bottom-right, auto-dismisses after
 * a few seconds, and opens the overlay when clicked. Replaces the older in-dock
 * banner and the dark inline toast.
 */
import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { FireEvent } from "./FlowletPoller";

const DISMISS_MS = 5000;

export function FlowletToast({
  fire,
  onOpen,
  onDismiss,
}: {
  fire: FireEvent | null;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!fire) return;
    const id = setTimeout(onDismiss, DISMISS_MS);
    return () => clearTimeout(id);
  }, [fire, onDismiss]);

  return (
    <AnimatePresence>
      {fire ? (
        <motion.div
          key={fire.txnId}
          role="status"
          onClick={onOpen}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ type: "spring", stiffness: 360, damping: 30 }}
          style={{
            position: "fixed",
            right: 24,
            bottom: 24,
            zIndex: 2147483002,
            width: 320,
            cursor: "pointer",
            display: "flex",
            gap: 12,
            alignItems: "flex-start",
            padding: "14px 14px 14px 16px",
            borderRadius: 16,
            color: "var(--flowlet-fg)",
            background: "var(--flowlet-glass)",
            WebkitBackdropFilter: "var(--flowlet-blur)",
            backdropFilter: "var(--flowlet-blur)",
            border: "1px solid var(--flowlet-border-strong)",
            boxShadow: "0 18px 50px color-mix(in srgb, var(--flowlet-fg) 24%, transparent)",
          }}
        >
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 0,
              top: 14,
              bottom: 14,
              width: 3,
              borderRadius: 3,
              background: "var(--flowlet-ok)",
              boxShadow: "0 0 14px color-mix(in srgb, var(--flowlet-ok) 70%, transparent)",
            }}
          />
          <span
            aria-hidden
            style={{
              flex: "0 0 auto",
              marginTop: 1,
              width: 20,
              height: 20,
              borderRadius: "50%",
              border: "1.5px solid var(--flowlet-ok)",
              display: "grid",
              placeItems: "center",
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--flowlet-ok)" }} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 650, letterSpacing: "-.005em" }}>
              Automation ran → <span style={{ color: "var(--flowlet-ok)" }}>#{fire.channel}</span>
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--flowlet-fg-muted)",
                marginTop: 3,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {fire.merchant} · ${fire.amountDollars.toFixed(2)} · {fire.time}
              {fire.slack.fallback ? " · offline fallback" : ""}
            </div>
            <div style={{ fontSize: 11, color: "var(--flowlet-fg-muted)", marginTop: 9 }}>
              Click to open Maple ›
            </div>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            aria-label="Dismiss"
            style={{
              position: "absolute",
              top: 8,
              right: 9,
              background: "transparent",
              border: 0,
              cursor: "pointer",
              color: "var(--flowlet-fg-muted)",
              fontSize: 15,
              lineHeight: 1,
              padding: 2,
            }}
          >
            ×
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
