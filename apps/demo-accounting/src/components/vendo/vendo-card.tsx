"use client";

import { VendoSlot } from "@vendoai/ui/chrome";
import { VendoRoot } from "./VendoRoot";

export function VendoCard() {
  return (
    <section aria-label="Custom view" className="space-y-2">
      <VendoRoot threadId="thr_cadence_slot">
        <VendoSlot id="home-dashboard">
          <a className="block rounded-xl border border-dashed border-line p-6 text-sm text-ink-soft" href="/assistant">
            Design a view with Vendo
          </a>
        </VendoSlot>
        {/* VENDO-MIGRATION: the v0 slot contract mounts an existing app by id;
            it does not include the retired slot-local creation composer. */}
      </VendoRoot>
    </section>
  );
}
