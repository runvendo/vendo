"use client";

/**
 * The automation alert, on fluidkit's toast system. When a rule fires while
 * the overlay is closed, a liquid toast condenses bottom-right (fluidkit owns
 * placement, entrance/evaporate motion, queueing, and reduced-motion), with
 * an Open action that jumps into the overlay. Fire-and-forget notifications
 * are exactly LiquidToast's model — unlike the shell's controlled undo toast,
 * which stays hand-rolled by design.
 */
import { useEffect } from "react";
import { LiquidToastProvider, toast } from "fluidkit";
import type { FireEvent } from "./FlowletPoller";

const DISMISS_MS = 5000;

function FireMessage({ fire }: { fire: FireEvent }) {
  // A rule matched, but the Slack post itself may have failed. Surface that
  // truthfully instead of always claiming "posted". (When the staged offline
  // fallback is on, we intentionally still present it as posted.)
  const failed = !fire.slack.ok && !fire.slack.fallback;
  const accent = failed ? "var(--flowlet-danger)" : "var(--flowlet-ok)";
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
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
        <div style={{ fontSize: 12, opacity: 0.72, marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
          {fire.merchant} · ${fire.amountDollars.toFixed(2)} · {fire.time}
          {fire.slack.fallback ? " · offline fallback" : failed ? " · Slack post failed" : ""}
        </div>
      </div>
    </div>
  );
}

export function FlowletToast({
  fire,
  onOpen,
}: {
  fire: FireEvent | null;
  onOpen: () => void;
}) {
  useEffect(() => {
    if (!fire) return;
    toast(<FireMessage fire={fire} />, {
      id: fire.txnId,
      duration: DISMISS_MS,
      action: { label: "Open", onClick: onOpen },
    });
  }, [fire, onOpen]);

  return <LiquidToastProvider position="bottom-right" />;
}
