/**
 * Surface #2 — the invisible Cmd/Ctrl+K overlay, mounted once over the whole
 * app. No persistent launcher: Vendo is summoned from anywhere with the
 * shortcut, sharing the "gmail-demo" thread with the full page surface.
 */
import React from "react";
import { VendoOverlay } from "@vendoai/shell";
import { VendoRoot } from "./VendoRoot";

const SUGGESTIONS = [
  "Turn my unread emails into Tinder: swipe left to delete, swipe right to reply for me. Swipe up to send it to my team's Slack with a quick summary.",
  "What needs my attention today?",
  "Summarize my unread emails",
];

export function VendoLayer() {
  return (
    <VendoRoot>
      <VendoOverlay
        shortcutKey="k"
        launcherLabel="Ask Vendo"
        greeting="Ask Vendo anything"
        suggestions={SUGGESTIONS}
      />
    </VendoRoot>
  );
}
