"use client";

import { VendoPage } from "@vendoai/ui/chrome";
import { VendoRoot } from "@/components/vendo/VendoRoot";
import { useTryThisChips } from "@/components/vendo/use-try-this-chips";
import { mapleScenarios } from "@/vendo/scenarios";

/** Ask Maple IS the shipped workspace console (VendoPage): threads, apps,
 *  automations, accounts and activity tabs — the same surface the Vendo
 *  playground showcases — with Maple's curated starter cards riding the chat
 *  tab. The voice stage no longer docks here (2026-07-30 polish: the fixed
 *  260px slot under the thread was the clutter); /vendo/workspace stays as an
 *  alias route. */
export default function VendoTabPage() {
  // "Try this" chips (demo-hygiene): pre-generated prompts as pill chips one
  // tier below the scenario cards. An empty cache keeps the ORIGINAL
  // mapleScenarios reference (and no extra render, see useTryThisChips), so
  // the first-visit landing contract — one render, cards only — holds.
  const chips = useTryThisChips();
  const suggestions = chips.length === 0 ? mapleScenarios : [...mapleScenarios, ...chips];
  return (
    <div style={{ height: "calc(100dvh - 112px)", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <VendoRoot>
        <VendoPage thread={{ suggestions, discoverability: "quiet" }} />
      </VendoRoot>
    </div>
  );
}
