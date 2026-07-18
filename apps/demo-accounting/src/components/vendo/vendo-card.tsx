"use client";

import { VendoSlot } from "@vendoai/ui/chrome";
import { VendoRoot } from "./VendoRoot";
import { cadencePinnedDashboard } from "./pinned-dashboard";

export function VendoCard() {
  return (
    <section aria-label="Custom view" className="space-y-2">
      <VendoRoot threadId="thr_cadence_slot">
        {/* ENG-230 — the slot's FILLED state, reachable via the ENG-223 pin path
            (a pinned vendo-genui/v1 dashboard). The host <a> stays the pin
            error fallback (06-apps §8). */}
        <VendoSlot id="home-dashboard" pin={{ payload: cadencePinnedDashboard }}>
          <a className="block rounded-xl border border-dashed border-line p-6 text-sm text-ink-soft" href="/assistant">
            Design a view with Vendo
          </a>
        </VendoSlot>
      </VendoRoot>
    </section>
  );
}
