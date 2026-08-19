/**
 * The last host-side formatting boundary, held.
 *
 * A screen formats its own values now: the author divides the cents and hands the
 * Kit finished text, and a compiler, a reviewer and a person reading the diff can
 * all see the division. A chart is the one exception — its ticks, tooltips and bar
 * labels are computed HOST-side off a numeric scale, so the series stay numeric
 * and `format="money"` is how the chart is told what they mean. It converts
 * nothing. So that prop is the only place left in a screen where a hundred-times
 * invention can still ORIGINATE, and it originated twice on real screens:
 * `maple/spend-overview` printed six raw cent values in a donut legend ($285,000
 * of housing against a host holding 285000 cents), and `buildlog/compute-spend`
 * did the same to a chart of branch costs.
 *
 * What is real here: the screen below is that run's own artifact
 * (`genbench/runs/2026-08-18T18-47-44/vendo-sonnet/buildlog/compute-spend`), its
 * data prep copied out verbatim down to the name `costCents`, with the table and
 * the buttons dropped because the chart is what is being decided. The refusal is
 * proved on that shape with the one division removed, and the shape that really
 * shipped — the same screen with `/ 100` back in the map — has to pass, or the
 * check refuses the correct code and buys nothing.
 */
import { describe, expect, it } from "vitest";
import type { JsonSchema } from "@vendoai/core";
import { KIT_SPECS } from "../../src/contract/index.js";
import { checkComponentScreen, type ComponentScreenCheck } from "../../src/server/checking/component-screen.js";
import type { HostToolInfo } from "../../src/server/checking/deps.js";

const buildsSchema: JsonSchema = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          branch: { type: "string" },
          compute_cost: { type: "number" },
          amount_cents: { type: "number" },
        },
        required: ["id", "branch", "compute_cost", "amount_cents"],
        additionalProperties: false,
      },
    },
  },
  required: ["data"],
  additionalProperties: false,
};

const tools: readonly HostToolInfo[] = [
  {
    name: "list_builds",
    description: "This morning's CI builds. `compute_cost` and `amount_cents` are in CENTS.",
    risk: "read",
    inputSchema: { type: "object", properties: {} },
    outputSchema: buildsSchema,
  },
];

/** The three builds of the run's own morning, in the host's own minor units. */
const ROWS = {
  data: [
    { id: "bld_4191", branch: "main", compute_cost: 1_870, amount_cents: 1_870 },
    { id: "bld_4189", branch: "main", compute_cost: 1_810, amount_cents: 1_810 },
    { id: "bld_4192", branch: "feat/timeline-brick", compute_cost: 620, amount_cents: 620 },
  ],
};

const catalog = ["Stack", "Text", "DonutChart", "BarChart", "LineChart", "Sparkline"];

const check = async (source: string): Promise<ComponentScreenCheck> =>
  await checkComponentScreen({ source, hostTools: tools, catalog, runQuery: async () => ROWS });

const refusal = async (source: string): Promise<{ codes: string[]; text: string }> => {
  const result = await check(source);
  if (result.ok) throw new Error("expected the gauntlet to refuse this screen");
  return { codes: result.issues.map(({ code }) => code), text: result.issues.map(({ message }) => message).join("\n") };
};

/** The compute-spend artifact's own chart, `PREP` verbatim from the run, with
 *  whatever the test wants written into the map's `cost` field. */
const computeSpend = (cost: string): string => `import { useQuery, Stack, Text, DonutChart } from "@vendo/screen";

export default function CIOverview() {
  const builds = useQuery("list_builds");
  const rows = builds.data;

  const branchMap = {};
  rows.forEach((b) => {
    if (!branchMap[b.branch]) branchMap[b.branch] = { branch: b.branch, costCents: 0, count: 0 };
    branchMap[b.branch].costCents += b.compute_cost;
    branchMap[b.branch].count += 1;
  });
  const byBranch = Object.keys(branchMap).map((branch) => ({
    branch,
    count: branchMap[branch].count,
    cost: ${cost},
  }));

  return (
    <Stack gap={16}>
      <Text text="Cost by branch" variant="label" />
      <DonutChart data={byBranch} categoryKey="branch" valueKey="cost" format="money" />
    </Stack>
  );
}
`;

describe("a chart told its numbers are money", () => {
  it("refuses the branch-cost chart when the cents accumulator reaches valueKey undivided", async () => {
    const { codes, text } = await refusal(computeSpend("branchMap[branch].costCents"));

    expect(codes).toContain("chart-money-cents");
    // The evidence: which field, which chart, and what fills it.
    expect(text).toContain('plots "cost" on <DonutChart> with format="money"');
    expect(text).toContain("costCents with nothing dividing it by 100");
    // And the fix, named — a refusal a model cannot act on costs a whole round.
    expect(text).toContain('format="money" reads DOLLARS and converts nothing');
    expect(text).toContain("divide the cents field where you PREPARE the data");
    expect(text).toContain("cost: row.costCents / 100");
  });

  /** The same screen as it really shipped. A tripwire that also refuses the
   *  correct form is a tripwire nobody can satisfy. */
  it("passes that chart with the division back in the map", async () => {
    const result = await check(computeSpend("branchMap[branch].costCents / 100"));

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  /** The other shape it arrives in: no prep at all, the chart reading the row's
   *  own minor-unit field by name. */
  it("refuses a chart reading a row's own cents field straight through", async () => {
    const { codes, text } = await refusal(`import { useQuery, Stack, DonutChart } from "@vendo/screen";

export default function Spend() {
  const builds = useQuery("list_builds");
  return (
    <Stack>
      <DonutChart data={builds.data} categoryKey="branch" valueKey="amount_cents" format="money" />
    </Stack>
  );
}
`);

    expect(codes).toEqual(["chart-money-cents"]);
    expect(text).toContain('plots "amount_cents" on <DonutChart>');
    expect(text).toContain("amount_cents: row.amount_cents / 100");
  });

  /**
   * And the scope, said out loud. This is ONE boundary, not a cents heuristic: the
   * same undivided field under any other format is a number nobody claimed was
   * money, and refusing it would be this check growing into the general rule it
   * must not become.
   */
  it("says nothing about the same field plotted as a plain number", async () => {
    const result = await check(`import { useQuery, Stack, DonutChart } from "@vendo/screen";

export default function Spend() {
  const builds = useQuery("list_builds");
  return (
    <Stack>
      <DonutChart data={builds.data} categoryKey="branch" valueKey="amount_cents" format="number" />
    </Stack>
  );
}
`);

    expect(result.issues).toEqual([]);
  });

  /**
   * The list of charts this rule knows, kept honest against the Kit itself: a
   * fourth chart that takes a `format` and looks its numbers up by key is a fourth
   * way to print cents as dollars, and it must not arrive unwatched.
   */
  it("covers every chart the Kit lets say money", async () => {
    const charts = KIT_SPECS.filter(
      (spec) =>
        spec.group === "charts"
        && "format" in spec.props
        && ("valueKey" in spec.props || "series" in spec.props),
    );
    expect(charts.map((spec) => spec.name)).toEqual(["LineChart", "BarChart", "DonutChart"]);

    for (const { name } of charts) {
      // Every key prop at once: stage 2 refuses before the type check reads a
      // prop the chart does not take, so one written screen serves all three.
      const { codes } = await refusal(`import { useQuery, Stack, ${name} } from "@vendo/screen";

export default function Spend() {
  const builds = useQuery("list_builds");
  return (
    <Stack>
      <${name} data={builds.data} xKey="branch" categoryKey="branch" series={["amount_cents"]} valueKey="amount_cents" format="money" />
    </Stack>
  );
}
`);

      expect(codes, name).toEqual(["chart-money-cents"]);
    }
  });
});
