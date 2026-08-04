"use client";

import { VendoPage } from "@vendoai/ui/chrome";
import { VendoRoot } from "@/components/vendo/VendoRoot";
import { useTryThisChips } from "@/components/vendo/use-try-this-chips";
import { cadenceScenarios } from "@/vendo/scenarios";

/** The assistant IS the shipped workspace console (VendoPage) — threads,
 *  apps, automations, accounts and activity tabs, the same surface the Vendo
 *  playground showcases — with Cadence's curated starter cards riding the
 *  chat tab (2026-07-30 polish: replaces the hand-rolled Chat/Activity
 *  two-tab shell). */
export default function AssistantPage() {
  // "Try this" chips (demo-hygiene): pre-generated prompts as pill chips one
  // tier below the scenario cards; absent entirely while the cache is empty.
  const chips = useTryThisChips();
  const suggestions = chips.length === 0 ? cadenceScenarios : [...cadenceScenarios, ...chips];
  return (
    <div
      style={{
        height: "calc(100dvh - 120px)",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        // ENG-228: x stays scrollable so the thread's new min-width floor is
        // reachable when this host's fixed sidebar squeezes the column at
        // mobile widths (375px was rendering one character per line).
        overflowX: "auto",
        overflowY: "hidden",
        position: "relative",
      }}
    >
      <VendoRoot>
        <VendoPage
          thread={{
            suggestions,
            discoverability: "quiet",
            // Cadence's own Sift-style hero copy (title · tagline · eyebrow ·
            // icon) — the shared chrome stays brand-neutral; the words are ours.
            greeting: "Ask anything about your practice",
            intro:
              "Cadence knows your clients, documents, and deadlines. Ask in plain English and get an answer you can act on — or pin as a view.",
            heroEyebrow: "Ask Cadence",
            heroIcon: "C",
          }}
        />
      </VendoRoot>
    </div>
  );
}
