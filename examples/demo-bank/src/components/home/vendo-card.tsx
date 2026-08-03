"use client";

import { VendoSlot } from "@vendoai/ui/chrome";
import { VendoRoot } from "@/components/vendo/VendoRoot";

/**
 * The Home hero slot — a REAL VendoSlot with the stable id "home-hero".
 * It self-discovers whatever app the user pinned (the thread embed's
 * "Pin to dashboard" affordance records the pin server-side; the slot's
 * own polling picks it up). Empty, it renders the ghost invitation with
 * Maple-flavored prompts that prefill the Ask Maple composer.
 */
export function VendoCard() {
  return (
    <section aria-label="Custom view" className="h-full">
      <VendoRoot>
        <VendoSlot
          id="home-hero"
          emptyState={{
            title: "This space builds itself",
            subtitle: "ask Maple for a view — it renders here, live on your data",
            suggestions: [
              "Build my money HQ",
              "Show my spending by category",
              "Track my savings goals",
            ],
          }}
        />
      </VendoRoot>
    </section>
  );
}
