import { describe, expect, it } from "vitest";
import { islandDerivedValueViolations } from "./island-derived-values.js";

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
