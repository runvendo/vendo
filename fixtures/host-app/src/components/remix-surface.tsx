"use client";
// The remixable wrapper surface sync captures: a plain import, an aliased
// import, a barrel re-export chain, and a namespace member. Sync trusts a
// wrapper only when the use site imports it from @vendoai/ui, so the fixture
// uses the real package. No route renders this component — <Remixable> needs
// a <VendoProvider> this bare fixture host does not mount, and sync's scan
// walks every source file regardless.
import { Remixable } from "@vendoai/ui/chrome";
import { InvoiceCard } from "./InvoiceCard";
import { AliasedCard as RenamedCard } from "./AliasedCard";
import { BarrelCard } from "./barrel";
import * as NamespaceCards from "./NamespaceCard";

export function RemixSurface() {
  return (
    <>
      <Remixable>
        <InvoiceCard id="INV-1" amountCents={125000} currency="USD" status="open" memo="Fixture invoice" />
      </Remixable>
      <Remixable>
        <RenamedCard />
      </Remixable>
      <Remixable>
        <BarrelCard />
      </Remixable>
      <Remixable>
        <NamespaceCards.NamespaceCard />
      </Remixable>
    </>
  );
}
