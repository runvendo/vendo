import { StatusBadge } from "./StatusBadge";

interface InvoiceCardProps {
  id: string;
  amountCents: number;
  currency: "USD";
  status: "draft" | "open" | "paid";
  memo: string;
}

export function InvoiceCard({
  id,
  amountCents,
  currency,
  status,
  memo,
}: InvoiceCardProps) {
  return (
    <article style={{ border: "1px solid #d1d5db", borderRadius: 8, padding: 16 }}>
      <header style={{ display: "flex", justifyContent: "space-between" }}>
        <strong>{id}</strong>
        <StatusBadge status={status} />
      </header>
      <p>{memo}</p>
      <p>
        {currency} {(amountCents / 100).toFixed(2)}
      </p>
    </article>
  );
}
