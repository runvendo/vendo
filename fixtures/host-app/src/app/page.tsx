import { Remixable } from "../vendo/remixable";
import { InvoiceCard } from "../components/InvoiceCard";
import { AliasedCard as RenamedCard } from "../components/AliasedCard";
import { BarrelCard } from "../components/barrel";
import * as NamespaceCards from "../components/NamespaceCard";

const apiSurface = [
  "POST /api/login",
  "GET, POST /api/invoices",
  "GET, PATCH, DELETE /api/invoices/:id",
  "POST /api/invoices/:id/send",
  "GET /api/invoices/archive",
  "GET /api/customers",
];

export default function HomePage() {
  return (
    <main>
      <h1>Seeded invoice fixture</h1>
      <p>Sign in through the login endpoint, then exercise the deterministic API.</p>
      <ul>
        {apiSurface.map((route) => (
          <li key={route}>{route}</li>
        ))}
      </ul>
      {/* The remixable wrapper surface sync captures: a plain import, an
          aliased import, a barrel re-export chain, and a namespace member. */}
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
    </main>
  );
}
