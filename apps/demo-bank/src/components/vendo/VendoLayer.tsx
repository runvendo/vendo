"use client";

/**
 * The Vendo layer dropped over Maple. A single client island that owns the
 * shared agent session and the Cmd/Ctrl+K overlay. Mounted once in the root layout so it floats
 * above the untouched bank UI — the "we dropped in one layer" thesis, literally.
 *
 * No persistent launcher: Vendo is invisible until summoned with Cmd/Ctrl+K.
 */
import { useEffect } from "react";
import { VendoOverlay } from "@vendoai/shell";
import { VendoRoot } from "./VendoRoot";
import { mapleRealtimeVoiceDriver } from "./voice-realtime";
import { resetDemo } from "./reset";

const SUGGESTIONS = [
  "What did I spend money on when I should've been asleep?",
  "What was that $87 DoorDash charge?",
];

export function VendoLayer() {
  // Stage shortcuts:
  // Cmd/Ctrl+Shift+Period resets the demo to a clean state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.code === "Period") {
        e.preventDefault();
        void resetDemo();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <VendoRoot>
      {/* The only surface: invisible until summoned with Cmd/Ctrl+K. */}
      <VendoOverlay
        shortcutKey="k"
        launcherLabel="Ask Maple"
        greeting="Ask Maple anything"
        suggestions={SUGGESTIONS}
        voice={mapleRealtimeVoiceDriver}
      />
    </VendoRoot>
  );
}
