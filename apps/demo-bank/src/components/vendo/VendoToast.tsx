"use client";

/**
 * The automation alert, now self-standing. When a rule fires while the overlay
 * is closed, this graphite-glass toast slides in bottom-right, auto-dismisses
 * after a few seconds, and opens the overlay when clicked. It replaces the fire
 * banner that used to live inside the (now-deleted) dock.
 */
import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { FireEvent } from "./VendoPoller";

const DISMISS_MS = 5000;

export function VendoToast({
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

  // A rule matched, but the Slack post itself may have failed. Surface that
  // truthfully instead of always claiming "posted". (When the staged offline
  // fallback is on, we intentionally still present it as posted.)
  const failed = fire ? !fire.slack.ok && !fire.slack.fallback : false;
  const accent = failed ? "var(--vendo-danger)" : "var(--vendo-ok)";

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
            zIndex: 2147482900,
            width: 320,
            cursor: "pointer",
            display: "flex",
            gap: 12,
            alignItems: "flex-start",
            padding: "14px 14px 14px 16px",
            borderRadius: 16,
            color: "var(--vendo-fg)",
            background: "var(--vendo-glass)",
            WebkitBackdropFilter: "var(--vendo-blur)",
            backdropFilter: "var(--vendo-blur)",
            border: "1px solid var(--vendo-border-strong)",
            boxShadow: "0 18px 50px color-mix(in srgb, var(--vendo-fg) 24%, transparent)",
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
              background: accent,
              boxShadow: `0 0 14px color-mix(in srgb, ${accent} 70%, transparent)`,
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
              border: `1.5px solid ${accent}`,
              display: "grid",
              placeItems: "center",
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: accent }} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 650, letterSpacing: "-.005em" }}>
              {failed ? "Couldn't post to " : "Rule fired → "}
              <span style={{ color: accent }}>#{fire.channel}</span>
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--vendo-fg-muted)",
                marginTop: 3,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {fire.merchant} · ${fire.amountDollars.toFixed(2)} · {fire.time}
              {fire.slack.fallback ? " · offline fallback" : failed ? " · Slack post failed" : ""}
            </div>
            <div style={{ fontSize: 11, color: "var(--vendo-fg-muted)", marginTop: 9 }}>
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
              color: "var(--vendo-fg-muted)",
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
