"use client";

import { VendoSlot } from "@vendoai/ui/chrome";
import { VendoRoot } from "@/components/vendo/VendoRoot";

export function VendoCard() {
  return (
    <section aria-label="Custom view" className="space-y-2">
      <VendoRoot threadId="maple-slot">
        <VendoSlot id="home-dashboard">
          <a className="block rounded-xl border border-dashed border-border p-6 text-sm text-muted" href="/vendo">
            Design a view with Maple
          </a>
        </VendoSlot>
        {/* VENDO-MIGRATION: the v0 slot contract mounts an existing app by id;
            it does not include the retired slot-local creation composer. */}
      </VendoRoot>
    </section>
  );
}
