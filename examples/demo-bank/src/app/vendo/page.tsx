"use client";

import { VendoPage } from "@vendoai/ui/chrome";
import { VendoRoot } from "@/components/vendo/VendoRoot";
import { mapleScenarios } from "@/vendo/scenarios";

/** Ask Maple IS the shipped workspace console (VendoPage): threads, apps,
 *  automations, accounts and activity tabs — the same surface the Vendo
 *  playground showcases — with Maple's curated starter cards riding the chat
 *  tab. The voice stage no longer docks here (2026-07-30 polish: the fixed
 *  260px slot under the thread was the clutter); /vendo/workspace stays as an
 *  alias route. */
export default function VendoTabPage() {
  return (
    <div style={{ height: "calc(100dvh - 112px)", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <VendoRoot>
        <VendoPage thread={{ suggestions: mapleScenarios, discoverability: "quiet" }} />
      </VendoRoot>
    </div>
  );
}
