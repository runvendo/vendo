"use client";

/**
 * The Flowlet layer dropped over Maple. A single client island that owns the
 * shared agent session, the background poller, and the backstage order-inject
 * fallback. Mounted once in the root layout so it floats above the untouched
 * bank UI — the "we dropped in one layer" thesis, literally.
 *
 * Flowlet is summoned with Cmd/Ctrl+K (one surface, no always-on dock). When an
 * automation fires, a toast announces it regardless of whether the overlay is open.
 */
import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, X } from "lucide-react";
import { FlowletOverlay } from "@flowlet/shell";
import { FlowletRoot } from "./FlowletRoot";
import { FlowletPoller, type FireEvent } from "./FlowletPoller";
import { FlowletSaver, type SavedView } from "./FlowletSaver";
import { SavedViews } from "./SavedViews";
import { resetDemo } from "./reset";

const SUGGESTIONS = [
  "What did I spend money on when I should've been asleep?",
  "What was that $87 DoorDash charge?",
];

/** Announces an automation firing — replaces the old in-dock banner. */
function FireToast({ fire, onDismiss }: { fire: FireEvent; onDismiss: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12 }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
      style={{
        position: "fixed",
        right: 24,
        bottom: 24,
        zIndex: 2147483002,
        display: "flex",
        gap: 11,
        alignItems: "flex-start",
        maxWidth: 360,
        padding: "13px 15px",
        borderRadius: 14,
        background: "#1b1c22",
        color: "#f4f3f0",
        boxShadow: "0 18px 50px rgba(20,21,26,.4)",
      }}
    >
      <Bell size={17} style={{ marginTop: 1, flexShrink: 0 }} aria-hidden />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Automation ran &middot; posted to #{fire.channel}</div>
        <div style={{ fontSize: 12, opacity: 0.78, marginTop: 2 }}>
          {fire.merchant} ${fire.amountDollars.toFixed(2)} at {fire.time}
          {fire.slack.fallback ? " · offline fallback" : ""}
        </div>
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{ background: "transparent", border: 0, color: "#f4f3f0", opacity: 0.6, cursor: "pointer", padding: 0 }}
      >
        <X size={15} aria-hidden />
      </button>
    </motion.div>
  );
}

export function FlowletLayer() {
  const [fire, setFire] = useState<FireEvent | null>(null);
  const [saved, setSaved] = useState<SavedView[]>([]);
  const pathname = usePathname();
  // On the dedicated Flowlet tab, that page IS the surface — hide the floating bits.
  const floating = pathname !== "/flowlet";

  const addSaved = useCallback((v: SavedView) => {
    setSaved((prev) => (prev.some((s) => s.id === v.id) ? prev : [...prev, v]));
  }, []);

  // Stage shortcuts:
  //  - Cmd/Ctrl+Shift+Backslash: backstage inject of a late-night order (same
  //    write the order page uses) so the poller trips identically as a fallback.
  //  - Cmd/Ctrl+Shift+Period: reset the demo to a clean state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.code === "Backslash") {
        e.preventDefault();
        void fetch("/api/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      } else if (e.code === "Period") {
        e.preventDefault();
        void resetDemo();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <FlowletRoot>
      <FlowletPoller onFire={setFire} />
      <FlowletSaver onSave={addSaved} />
      {floating ? <SavedViews views={saved} /> : null}
      {/* The one floating surface: the shared thread, summoned anywhere via Cmd/Ctrl+K. */}
      <FlowletOverlay
        shortcutKey="k"
        hideLauncher
        greeting="Ask Maple anything"
        suggestions={SUGGESTIONS}
      />
      <AnimatePresence>
        {floating && fire ? <FireToast key="fire" fire={fire} onDismiss={() => setFire(null)} /> : null}
      </AnimatePresence>
    </FlowletRoot>
  );
}
