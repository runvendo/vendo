"use client";

import { VendoSlot } from "@vendoai/ui/chrome";
import { VendoRoot } from "@/components/vendo/VendoRoot";
import { maplePinnedDashboard } from "./pinned-dashboard";

export function VendoCard() {
  return (
    <section aria-label="Custom view" className="space-y-2">
      <VendoRoot threadId="thr_maple_slot">
        {/* ENG-230 — the slot's FILLED state, reachable via the ENG-223 pin path
            (a pinned vendo-genui/v1 dashboard). The host <a> stays the pin
            error fallback (06-apps §8). */}
        <VendoSlot id="home-dashboard" pin={{ payload: maplePinnedDashboard }}>
          <a className="block rounded-xl border border-dashed border-border p-6 text-sm text-muted" href="/vendo">
            Design a view with Maple
          </a>
        </VendoSlot>
      </VendoRoot>
    </section>
  );
}
