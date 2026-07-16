"use client";

import { VendoThread } from "@vendoai/ui/chrome";
import { DemoChrome, type DemoChromeRefusal } from "@/components/demo-chrome";
import { SuggestionChips } from "@/components/suggestion-chips";
import { VendoRoot } from "@/components/vendo/VendoRoot";
import type { DemoBeat } from "@/lib/demo-config";

// ============================================================================
// PLUMBING — RESTYLE, DON'T REWIRE, PER PROSPECT.
// Client composition of the /vendo panel: demo chrome (badge/CTA/limit card)
// wrapping the beat chips + Vendo surface. Lives in its own client file
// because @vendoai/ui ships no "use client" directives — the server page
// (src/app/vendo/page.tsx) loads demo.config + caps status and passes them in.
// Creator agents may change wrapper layout/styling (the outer div, spacing,
// ordering of chips vs thread), but three wirings are LOAD-BEARING and must
// survive any rewrite:
//   1. DemoChrome wraps the whole surface (badge/CTA/limit card).
//   2. `initialRefusal` flows from the server page's peekRefusal() into
//      DemoChrome — dropping it kills the on-load limit/expired card.
//   3. VendoThread's `suggestions` get the beats' full prompts: clicking one
//      on the empty landing submits it directly (the official @vendoai/ui
//      seam) — losing this kills click-to-run for the demo beats.
// ============================================================================
export function DemoPanel(props: {
  prospect: string;
  ctaUrl: string;
  beats: DemoBeat[];
  initialRefusal: DemoChromeRefusal | null;
}) {
  const { prospect, ctaUrl, beats, initialRefusal } = props;
  return (
    <div
      style={{
        height: "100dvh",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
      }}
    >
      <DemoChrome prospect={prospect} ctaUrl={ctaUrl} initialRefusal={initialRefusal}>
        <SuggestionChips beats={beats} />
        <div className="flex min-h-0 flex-1 flex-col">
          <VendoRoot>
            <VendoThread suggestions={beats.map((beat) => beat.prompt)} />
          </VendoRoot>
        </div>
      </DemoChrome>
    </div>
  );
}
