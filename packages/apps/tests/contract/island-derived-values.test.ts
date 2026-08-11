import { describe, expect, it } from "vitest";
import { islandDerivedValueViolations } from "../../src/contract/island-derived-values.js";

/**
 * v4 wave — the M12 class (final gate 2026-07-21, third run in a row): an
 * island computed displayed EUR values from `const RATE = 0.92`. Law 1's
 * prompt principle did not hold; this scanner gives it teeth for constants
 * feeding displayed math. Scoped NARROWLY — a false positive here poisons
 * trust in the validator, so when in doubt it does not flag.
 */

const FX_ISLAND = `
export default function CurrencyConverter() {
  const RATE = 0.92;
  const [accounts, setAccounts] = useState([]);
  useEffect(() => {
    tools.host_listAccounts({}).then((res) => setAccounts(res.accounts ?? []));
  }, []);
  const totalUsd = accounts.reduce((sum, account) => sum + account.balance_cents, 0);
  const totalEur = totalUsd * RATE;
  return (
    <Stack>
      <Stat label="Total in EUR" value={fmt.money(totalEur)} />
      <DataTable rows={accounts.map((account) => ({
        name: account.name,
        eur: account.balance_cents * RATE,
      }))} />
    </Stack>
  );
}
`;

describe("islandDerivedValueViolations — the M12 FX-rate shape is caught", () => {
  it("flags a hand-typed constant multiplied into tool-derived values that render", () => {
    const violations = islandDerivedValueViolations(FX_ISLAND);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("RATE = 0.92");
    expect(violations[0]).toContain("a constant feeding displayed math is invented data (law 1)");
    expect(violations[0]).toContain("derive it from a tool result");
    expect(violations[0]).toContain("Disclaimer");
  });

  it("flags a bare numeric literal multiplied inline into rendered tool data", () => {
    const source = `
export default function Converter() {
  const [total, setTotal] = useState(0);
  useEffect(() => {
    tools.host_getBalance({}).then((res) => setTotal(res.total_cents ?? 0));
  }, []);
  return <Stat label="EUR estimate" value={fmt.money(total * 0.92)} />;
}
`;
    const violations = islandDerivedValueViolations(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("0.92");
  });

  it("flags when the tool result arrives through await instead of .then", () => {
    const source = `
export default function Converter() {
  const FX = 1.08;
  const [balance, setBalance] = useState(null);
  useEffect(() => {
    const load = async () => {
      const res = await tools.host_getBalance({});
      setBalance(res.balance_cents);
    };
    load();
  }, []);
  if (balance === null) return <Text text="Loading" />;
  const converted = balance * FX;
  return <Stat label="GBP" value={fmt.money(converted)} />;
}
`;
    const violations = islandDerivedValueViolations(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("FX = 1.08");
  });

  it("flags a hand-typed rate TABLE looked up into displayed math", () => {
    const source = `
export default function MultiConverter() {
  const RATES = { EUR: 0.92, GBP: 0.79 };
  const [accounts, setAccounts] = useState([]);
  useEffect(() => {
    tools.host_listAccounts({}).then((res) => setAccounts(res.accounts ?? []));
  }, []);
  const [currency, setCurrency] = useState("EUR");
  return (
    <Stack>
      <DataTable rows={accounts.map((account) => ({
        name: account.name,
        converted: account.balance_cents * RATES[currency],
      }))} />
    </Stack>
  );
}
`;
    const violations = islandDerivedValueViolations(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("RATES");
    expect(violations[0]).toContain("a constant feeding displayed math is invented data (law 1)");
  });

  it("flags derived math that reaches render through a state setter", () => {
    const source = `
export default function Converter() {
  const RATE = 1.08;
  const [total, setTotal] = useState(0);
  const [eur, setEur] = useState(0);
  useEffect(() => {
    tools.host_getBalance({}).then((res) => {
      setTotal(res.total_cents ?? 0);
      const eurCents = (res.total_cents ?? 0) * RATE;
      setEur(eurCents);
    });
  }, []);
  return <Stat label="EUR" value={fmt.money(eur)} />;
}
`;
    const violations = islandDerivedValueViolations(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("RATE = 1.08");
  });

  it("flags props-derived data multiplied by a hand-typed constant into render", () => {
    const source = `
export default function Projection({ monthlyCents }) {
  const GROWTH = 1.07;
  const nextYear = monthlyCents * GROWTH;
  return <Stat label="Projected" value={fmt.money(nextYear)} />;
}
`;
    const violations = islandDerivedValueViolations(source);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("GROWTH = 1.07");
  });
});

describe("islandDerivedValueViolations — exemptions (when in doubt, don't flag)", () => {
  it("passes a style-heavy island with padding math and a percent conversion untouched", () => {
    const source = `
export default function SpendBars(props) {
  const BAR = 8;
  const rows = props.categories ?? [];
  const max = rows.reduce((m, r) => Math.max(m, r.total_cents), 0) || 1;
  return (
    <Stack>
      {rows.map((r, i) => (
        <div key={r.name} style={{ width: (r.total_cents / max) * 240, padding: BAR * 2, gap: BAR }}>
          <Text text={r.name} />
          <Percent value={(r.total_cents / max) * 100} />
          <Money cents={r.total_cents} />
        </div>
      ))}
    </Stack>
  );
}
`;
    expect(islandDerivedValueViolations(source)).toEqual([]);
  });

  it("exempts 0, 1, and 100 (unit math and percent scaling)", () => {
    const source = `
export default function Summary(props) {
  const dollars = props.totalCents / 100;
  const next = props.count + 1;
  const ratio = props.received / (props.total || 1);
  return <Stat label="Collected" value={ratio * 100} hint={dollars + next} />;
}
`;
    expect(islandDerivedValueViolations(source)).toEqual([]);
  });

  it("exempts array-index arithmetic", () => {
    const source = `
export default function LastRow(props) {
  const rows = props.rows ?? [];
  const last = rows[rows.length - 1];
  return <Text text={last ? last.name : "none"} />;
}
`;
    expect(islandDerivedValueViolations(source)).toEqual([]);
  });

  it("exempts timeout and interval delays", () => {
    const source = `
export default function Poller(props) {
  const POLL_SECONDS = 30;
  const [rows, setRows] = useState([]);
  useEffect(() => {
    const id = setInterval(() => {
      tools.host_listRows({}).then((res) => setRows(res.rows ?? []));
    }, POLL_SECONDS * 1000);
    return () => clearInterval(id);
  }, []);
  return <DataTable rows={rows} />;
}
`;
    expect(islandDerivedValueViolations(source)).toEqual([]);
  });

  it("exempts layout-named constants used in sizing math", () => {
    const source = `
export default function Chart(props) {
  const CHART_HEIGHT = 240;
  const rows = props.points ?? [];
  const scale = rows.length ? CHART_HEIGHT / rows.length : CHART_HEIGHT;
  return <div style={{ height: CHART_HEIGHT }}>{rows.map((r, i) => <div key={i} style={{ height: r.value * scale }} />)}</div>;
}
`;
    expect(islandDerivedValueViolations(source)).toEqual([]);
  });

  it("does not flag constants whose math never touches tool or prop data", () => {
    const source = `
export default function Countdown() {
  const STEP = 5;
  const [count, setCount] = useState(60);
  return <Button label="Tick" onClick={() => setCount(count - STEP)} />;
}
`;
    expect(islandDerivedValueViolations(source)).toEqual([]);
  });

  it("does not flag tool-derived math that never renders", () => {
    const source = `
export default function Alerting() {
  const THRESHOLD = 2.5;
  const [rows, setRows] = useState([]);
  const [flagged, setFlagged] = useState(false);
  useEffect(() => {
    tools.host_listCharges({}).then((res) => {
      const items = res.charges ?? [];
      setRows(items);
      const mean = items.reduce((s, c) => s + c.amount_cents, 0) / (items.length || 1);
      if (items.some((c) => c.amount_cents > mean * THRESHOLD)) setFlagged(true);
    });
  }, []);
  return <DataTable rows={rows} emptyState={flagged ? "Unusual charges found" : "All clear"} />;
}
`;
    expect(islandDerivedValueViolations(source)).toEqual([]);
  });

  it("never fires on prose, strings, or comments", () => {
    const source = `
export default function Notes(props) {
  // the rate is 0.92 per the old spec * total
  const label = "converted at 0.92 * balance";
  return <Text text={label + " " + props.note} />;
}
`;
    expect(islandDerivedValueViolations(source)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rematch gate 2026-07-25 (docs/eval/runs/2026-07-25-rematch, rows H3, H12,
// H14, H16, H17, H24): the scanner refused the user's OWN numbers
// ($200 budget → BUDGET_CENTS = 20000) and plain unit conversions
// (12 months, 4.33 weeks/month, 1000*60*60*24 ms/day) as invented data.
// Two carve-outs; the M12 invented-FX-rate class must stay caught.
// ---------------------------------------------------------------------------

describe("islandDerivedValueViolations — user's own numbers (carve-out 1)", () => {
  const BUDGET_ISLAND = `
export default function BudgetTracker() {
  const BUDGET_CENTS = 20000;
  const [spent, setSpent] = useState(0);
  useEffect(() => {
    tools.host_listTransactions({}).then((res) => {
      setSpent((res.transactions ?? []).reduce((sum, txn) => sum + txn.amount_cents, 0));
    });
  }, []);
  const remaining = BUDGET_CENTS - spent;
  return <Stat label="Left this month" value={fmt.money(remaining)} />;
}
`;

  it("does not flag a constant that is the cent-scaled form of the user's typed number (H12: $200 → 20000)", () => {
    expect(islandDerivedValueViolations(BUDGET_ISLAND, {
      requestText: "keep my entertainment spending under a $200 monthly budget",
    })).toEqual([]);
  });

  it("without the request text the default stays no-carve-out (API compatible)", () => {
    expect(islandDerivedValueViolations(BUDGET_ISLAND)).toHaveLength(1);
    expect(islandDerivedValueViolations(BUDGET_ISLAND, {})).toHaveLength(1);
  });

  it("does not flag the user's comma-formatted $2,000 as NEED = 200000 (H14)", () => {
    const source = `
export default function SavingsGap() {
  const NEED = 200000;
  const [saved, setSaved] = useState(0);
  useEffect(() => {
    tools.host_listAccounts({}).then((res) => {
      setSaved((res.accounts ?? []).reduce((sum, account) => sum + account.balance_cents, 0));
    });
  }, []);
  return <Stat label="Still to save" value={fmt.money(NEED - saved)} />;
}
`;
    expect(islandDerivedValueViolations(source, {
      requestText: "show how far I am from saving $2,000 for the trip",
    })).toEqual([]);
    expect(islandDerivedValueViolations(source)).toHaveLength(1);
  });

  it("cent-scales fractional dollar amounts without float drift ($4.99 → 499)", () => {
    const source = `
export default function PriceGap() {
  const PRICE_CENTS = 499;
  const [balance, setBalance] = useState(0);
  useEffect(() => {
    tools.host_getBalance({}).then((res) => setBalance(res.balance_cents ?? 0));
  }, []);
  return <Stat label="After the subscription" value={fmt.money(balance - PRICE_CENTS)} />;
}
`;
    expect(islandDerivedValueViolations(source, {
      requestText: "what's left after my $4.99 subscription renews?",
    })).toEqual([]);
  });

  it("does not flag a bare literal that IS the user's number, unscaled", () => {
    const source = `
export default function Threshold() {
  const [charges, setCharges] = useState([]);
  useEffect(() => {
    tools.host_listCharges({}).then((res) => setCharges(res.charges ?? []));
  }, []);
  return <DataTable rows={charges.filter((charge) => charge.amount - 50 > 0).map((charge) => ({ name: charge.name }))} />;
}
`;
    expect(islandDerivedValueViolations(source, { requestText: "flag charges over 50 dollars" })).toEqual([]);
  });

  it("still flags an invented rate even when the request carries unrelated numbers", () => {
    expect(islandDerivedValueViolations(FX_ISLAND, {
      requestText: "convert my 3 accounts to euros",
    })).toHaveLength(1);
  });
});

describe("islandDerivedValueViolations — unit-conversion constants (carve-out 2)", () => {
  it("does not flag 12 / 52 / 4.33 in per-month math over tool data (H3)", () => {
    const source = `
export default function MonthlyRecurring() {
  const [charges, setCharges] = useState([]);
  useEffect(() => {
    tools.host_listRecurring({}).then((res) => setCharges(res.charges ?? []));
  }, []);
  const monthly = charges.reduce((sum, charge) => {
    if (charge.cadence === "yearly") return sum + charge.amount_cents / 12;
    if (charge.cadence === "weekly") return sum + charge.amount_cents * 4.33;
    return sum + charge.amount_cents;
  }, 0);
  const annual = charges.reduce((sum, charge) => (charge.cadence === "weekly" ? sum + charge.amount_cents * 52 : sum), 0);
  return (
    <Stack>
      <Stat label="Per month" value={fmt.money(monthly)} />
      <Stat label="Weekly, annualized" value={fmt.money(annual)} />
    </Stack>
  );
}
`;
    expect(islandDerivedValueViolations(source)).toEqual([]);
  });

  it("does not flag the 1000*60*60*24 ms/day chain in deadline math (H16/H17)", () => {
    const source = `
export default function DeadlineRisk() {
  const [clients, setClients] = useState([]);
  useEffect(() => {
    tools.host_listClients({}).then((res) => setClients(res.clients ?? []));
  }, []);
  return <DataTable rows={clients.map((client) => ({
    name: client.name,
    daysLeft: Math.ceil((new Date(client.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
  }))} />;
}
`;
    expect(islandDerivedValueViolations(source)).toEqual([]);
  });

  it("does not flag the composite ms/day product 86400000 in a division", () => {
    const source = `
export default function Aging({ invoices }) {
  const rows = (invoices ?? []).map((invoice) => ({
    id: invoice.id,
    ageDays: Math.floor((Date.now() - new Date(invoice.issued_at).getTime()) / 86400000),
  }));
  return <DataTable rows={rows} />;
}
`;
    expect(islandDerivedValueViolations(source)).toEqual([]);
  });

  it("does not flag a NAMED unit constant used multiplicatively", () => {
    const source = `
export default function Annualized({ weeklyCents }) {
  const WEEKS_PER_YEAR = 52;
  return <Stat label="Annualized" value={fmt.money(weeklyCents * WEEKS_PER_YEAR)} />;
}
`;
    expect(islandDerivedValueViolations(source)).toEqual([]);
  });

  it("STILL flags a unit-set value in additive math — a magic +12 is not a conversion", () => {
    const source = `
export default function Padded({ totalCents }) {
  const padded = totalCents + 12;
  return <Stat label="Total" value={fmt.money(padded)} />;
}
`;
    expect(islandDerivedValueViolations(source)).toHaveLength(1);
  });

  it("STILL flags the M12 FX-rate class — 0.92 is neither a user number nor a unit constant", () => {
    expect(islandDerivedValueViolations(FX_ISLAND)).toHaveLength(1);
    expect(islandDerivedValueViolations(FX_ISLAND, {
      requestText: "a currency converter for my balances",
    })).toHaveLength(1);
  });
});
