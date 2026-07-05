"use client";

/**
 * The Vendo layer dropped over Maple. A single client island that owns the
 * shared agent session, the Cmd/Ctrl+K overlay, the background poller, and the
 * backstage order-inject fallback. Mounted once in the root layout so it floats
 * above the untouched bank UI — the "we dropped in one layer" thesis, literally.
 *
 * No persistent launcher: Vendo is invisible until summoned with Cmd/Ctrl+K.
 * When a rule fires, a self-standing toast surfaces it bottom-right.
 */
import { useEffect, useState } from "react";
import { VendoOverlay } from "@vendoai/shell";
import { VendoRoot } from "./VendoRoot";
import { mapleRealtimeVoiceDriver } from "./voice-realtime";
import { VendoPoller, type FireEvent } from "./VendoPoller";
import { VendoToast } from "./VendoToast";
import { resetDemo } from "./reset";

const SUGGESTIONS = [
  "What did I spend money on when I should've been asleep?",
  "What was that $87 DoorDash charge?",
];

export function VendoLayer() {
  const [fire, setFire] = useState<FireEvent | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);

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
    <VendoRoot>
      <VendoPoller onFire={setFire} />
      <VendoToast
        fire={fire}
        onDismiss={() => setFire(null)}
        onOpen={() => {
          setFire(null);
          setOverlayOpen(true);
        }}
      />
      {/* The only surface: invisible until summoned with Cmd/Ctrl+K. */}
      <VendoOverlay
        shortcutKey="k"
        launcherLabel="Ask Maple"
        greeting="Ask Maple anything"
        suggestions={SUGGESTIONS}
        voice={mapleRealtimeVoiceDriver}
        open={overlayOpen}
        onOpenChange={setOverlayOpen}
      />
    </VendoRoot>
  );
}
