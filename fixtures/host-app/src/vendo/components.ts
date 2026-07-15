import { InvoiceCard } from "../components/InvoiceCard";
import { StatusBadge } from "../components/StatusBadge";
import { AliasedCard as RenamedCard } from "../components/AliasedCard";
import { BarrelCard } from "../components/barrel";
import * as NamespaceCards from "../components/NamespaceCard";

export const vendoComponents = [
  { name: "InvoiceCard", description: "Renders one invoice with amount and status", component: InvoiceCard, remixable: true, exportable: true },
  { name: "AliasedCard", description: "Exercises an aliased named import", component: RenamedCard, remixable: true },
  { name: "BarrelCard", description: "Exercises a named barrel re-export chain", component: BarrelCard, remixable: true },
  { name: "NamespaceCard", description: "Exercises a namespace import", component: NamespaceCards.NamespaceCard, remixable: true },
  { name: "StatusBadge", description: "Colored invoice status chip", component: StatusBadge },
];
