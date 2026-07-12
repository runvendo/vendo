import { InvoiceCard } from "../components/InvoiceCard";
import { StatusBadge } from "../components/StatusBadge";

export const vendoComponents = [
  { name: "InvoiceCard", description: "Renders one invoice with amount and status", component: InvoiceCard, remixable: true, exportable: true },
  { name: "StatusBadge", description: "Colored invoice status chip", component: StatusBadge },
];
