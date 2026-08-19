/**
 * A chart's figures are the SCREEN's own text, and this is the seam that carries
 * them.
 *
 * A screen runs in a VM, so its props cross to the renderer as JSON. A function
 * survives that crossing only where the Kit DECLARES it a slot and the VM calls it
 * (`contract/kit/specs.ts` SLOTS, `genui/component/vm-program.ts` emitSlot);
 * anything else becomes a `{$handler}` door — a callback the renderer binds to a
 * screen turn, returning `undefined`. Handed that where a tick label belongs, a
 * chart would print nothing and fire a re-render on every tick it painted.
 *
 * So the assertion here is not "the screen compiles". It is WHAT CROSSED: one
 * finished string per row, in the rows prop's order. That is the difference
 * between the feature and a green suite over a dead one — the whole file is here
 * because the `format="money"` tokens these replaced could turn 285000 cents into
 * "$285,000.00" with nobody writing the division down, and did, twice.
 */
import { describe, expect, it } from "vitest";
import type { JsonSchema } from "@vendoai/core";
import { checkComponentScreen, type ComponentScreenCheck } from "../../src/server/checking/component-screen.js";
import type { HostToolInfo } from "../../src/server/checking/deps.js";

/** Maple's own `get_spending`, whose unit is in the PROSE and whose field is
 *  called plain `amount` — the shape that made a naming rule useless. */
const spendingSchema: JsonSchema = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        properties: { category: { type: "string" }, amount: { type: "number" }, month: { type: "string" } },
        required: ["category", "amount", "month"],
        additionalProperties: false,
      },
    },
  },
  required: ["data"],
  additionalProperties: false,
};

const tools: readonly HostToolInfo[] = [
  {
    name: "get_spending",
    description: "This month's spending per category. `amount` is in CENTS: 285000 is $2,850.00.",
    risk: "read",
    inputSchema: { type: "object", properties: {} },
    outputSchema: spendingSchema,
  },
];

const SPENDING = {
  data: [
    { category: "housing", amount: 285_000, month: "2026-01-31" },
    { category: "groceries", amount: 61_245, month: "2026-02-28" },
  ],
};

const catalog = ["Stack", "Text", "DonutChart", "BarChart", "LineChart"];

const check = async (source: string): Promise<ComponentScreenCheck> =>
  await checkComponentScreen({
    source,
    hostTools: tools,
    catalog,
    runQuery: async () => SPENDING,
  });

/** The one chart node the screen painted, as the tree carries it. */
const chartProps = (result: ComponentScreenCheck, component: string): Record<string, unknown> => {
  const node = Object.values(result.initialTree?.nodes ?? {}).find((entry) => entry.component === component);
  if (node === undefined) throw new Error(`the screen painted no <${component}>`);
  return (node.props ?? {}) as Record<string, unknown>;
};

const HELPERS = `const money = (cents) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const month = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });`;

describe("a chart's formatter crosses the VM as text", () => {
  it("resolves a DonutChart's format to one finished string per row", async () => {
    const result = await check(`import { useQuery, Stack, DonutChart } from "@vendo/screen";

${HELPERS}

export default function Spend() {
  const spending = useQuery("get_spending");
  const rows = spending.data ?? [];
  return (
    <Stack gap={16}>
      <DonutChart data={rows} categoryKey="category" valueKey="amount" format={(row) => money(row.amount)} />
    </Stack>
  );
}
`);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    // The cents are divided in the screen's own helper, and what the ring is
    // handed is the finished text — no token, no `$handler`.
    expect(chartProps(result, "DonutChart")["format"]).toEqual(["$2,850.00", "$612.45"]);
  });

  it("resolves a series' own format and a LineChart's xFormat the same way", async () => {
    const result = await check(`import { useQuery, Stack, LineChart } from "@vendo/screen";

${HELPERS}

export default function Trend() {
  const spending = useQuery("get_spending");
  const rows = spending.data ?? [];
  return (
    <Stack gap={16}>
      <LineChart
        data={rows}
        xKey="month"
        series={[{ key: "amount", label: "Spend", format: (row) => money(row.amount) }]}
        xFormat={(row) => month(row.month)}
      />
    </Stack>
  );
}
`);

    expect(result.issues).toEqual([]);
    const props = chartProps(result, "LineChart");
    expect(props["xFormat"]).toEqual(["Jan", "Feb"]);
    // A series' formatter is a field of the descriptor it arrives in, exactly as
    // `columns[].cell` is — resolved over `data`, not over `series`.
    expect(props["series"]).toEqual([
      { key: "amount", label: "Spend", format: ["$2,850.00", "$612.45"] },
    ]);
  });

  /** The tokens are GONE, and the compiler is what says so: a screen that writes
   *  the old word gets a type error naming the prop, not a chart that silently
   *  multiplies its figures by a hundred. */
  it("refuses the retired format token as a type error", async () => {
    const result = await check(`import { useQuery, Stack, DonutChart } from "@vendo/screen";

export default function Spend() {
  const spending = useQuery("get_spending");
  return (
    <Stack gap={16}>
      <DonutChart data={spending.data ?? []} categoryKey="category" valueKey="amount" format="money" />
    </Stack>
  );
}
`);

    expect(result.ok).toBe(false);
    expect(result.issues.map(({ code }) => code)).toContain("types");
    expect(result.issues.map(({ message }) => message).join("\n")).toContain("format");
  });

  /** And a formatter that hands back a COMPONENT: legal against a slot type,
   *  which is why the formatter has one of its own — a chart would paint
   *  "[object Object]" on every tick and pass every other gate. */
  it("refuses a formatter that returns elements instead of text", async () => {
    const result = await check(`import { useQuery, Stack, Text, DonutChart } from "@vendo/screen";

export default function Spend() {
  const spending = useQuery("get_spending");
  return (
    <Stack gap={16}>
      <DonutChart data={spending.data ?? []} categoryKey="category" valueKey="amount" format={(row) => <Text text={String(row.amount)} />} />
    </Stack>
  );
}
`);

    expect(result.ok).toBe(false);
    expect(result.issues.map(({ code }) => code)).toContain("types");
  });
});
