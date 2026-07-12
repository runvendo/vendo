const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/** Absolute dollar amount from integer cents, e.g. 123456 -> "$1,234.56". */
export function formatUSD(cents: number): string {
  return usd.format(Math.abs(cents) / 100)
}

/** Signed amount for transaction rows: debit "-$87.00", credit "+$1,200.00", zero "$0.00". */
export function formatAmount(cents: number): string {
  if (cents === 0) return formatUSD(0)
  const body = formatUSD(cents)
  return cents < 0 ? `-${body}` : `+${body}`
}
