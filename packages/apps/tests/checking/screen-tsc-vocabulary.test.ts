/**
 * The false-positive gate.
 *
 * A check that blocks a GOOD screen is worse than no check: it stops a shipping
 * app on the strength of a hole in the generator. So one broad screen exercises
 * the whole vocabulary at once — every wire component, the aggregate calls, a
 * real host component, a real declared tool output schema — and must produce
 * exactly nothing. A component the generator forgot to declare shows up here as
 * "references unknown component", and a prop mistyped from its zod spec shows up
 * as an assignability error.
 *
 * The fixtures are copied verbatim from `examples/demo-bank/.vendo/` — the real
 * derived props schema of `MapleNetWorthCard` and the real declared
 * `outputSchema` of `host_getCashflowInsights` — rather than invented, so the
 * gate measures the shapes production really produces.
 */
import {
  type JsonSchema,
} from "@vendoai/core";
import {
  KIT_WIRE_COMPONENT_NAMES,
  WIRE_COMPONENT_NAMES,
  type NormalizedCatalog,
} from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { screenTypings } from "../../src/server/checking/screen-typings.js";
import { screenTscFindings } from "../../src/server/checking/screen-tsc.js";

/** examples/demo-bank/.vendo/catalog.json → MapleNetWorthCard.propsSchema */
const mapleNetWorthCard: JsonSchema = {
  type: "object",
  properties: {
    valueCents: { type: "number", description: "Total balance in integer cents" },
    series: { type: "array", items: { type: "number" }, description: "Balance history in integer cents" },
    changeLabel: { type: "string" },
    initialRange: { type: "string", enum: ["1W", "1M", "3M", "1Y", "All"] },
    chartHeight: { type: "number" },
  },
  required: ["valueCents", "series"],
  additionalProperties: false,
};

/** examples/demo-bank/.vendo/tools.json → host_getCashflowInsights.outputSchema */
const cashflowOutput: JsonSchema = {
  type: "object",
  properties: {
    data: {
      type: "array",
      description: "One entry per period, oldest first.",
      items: {
        type: "object",
        properties: { label: { type: "string" }, in: { type: "integer" }, out: { type: "integer" } },
        required: ["label", "in", "out"],
        additionalProperties: false,
      },
    },
  },
  required: ["data"],
  additionalProperties: false,
};

const catalog: NormalizedCatalog = [
  { name: "MapleNetWorthCard", description: "Net worth", propsJsonSchema: mapleNetWorthCard },
];

const typings = screenTypings({
  catalog,
  queries: [{ name: "cashflow", tool: "host_getCashflowInsights" }],
  toolOutputSchemas: { host_getCashflowInsights: cashflowOutput },
});

/** Every wire component, the computed forms a screen really writes (a `{...}`
 *  gap is a JavaScript expression over the declared queries — reduce/map/length,
 *  no call vocabulary), a real host component. */
const BROAD_SCREEN = `<App name="Cash flow">
  <Query id="cashflow" tool="host_getCashflowInsights"/>
  <Stack gap={16}>
    <Text text="Cash flow" variant="heading"/>
    {/* V4 — one component family: every name below is a Kit name, so the Kit
        spec IS the allowed prop set (there is no second, narrower legacy
        surface shadowing it any more). */}
    <Row gap={12} justify="between">
      <Stat label="Money in" value={cashflow.data.reduce((total, row) => total + row.in, 0) / 100} format="money"/>
      <Stat label="Money out" value={cashflow.data.reduce((total, row) => total + row.out, 0) / cashflow.data.length / 100} format="money"/>
      <Stat label="Periods" value={cashflow.data.length}/>
      <Stat label="Spread" value={cashflow.data.reduce((top, row) => (row.in > top ? row.in : top), 0) - cashflow.data.reduce((low, row) => (row.out < low ? row.out : low), 0)}/>
    </Row>
    <Grid columns={2}>
      <MapleNetWorthCard valueCents={cashflow.data.reduce((total, row) => total + row.in, 0)} series={[1, 2, 3]} initialRange="1M"/>
      <Card title="Detail" description="This period" tone="accent"><Divider/><Badge label="Live" tone="accent"/></Card>
    </Grid>
    <DataTable rows={cashflow.data} sortBy="label asc" limit={20} searchable={true} paginate={10}
      columns={[{ key: "label", label: "Period" }, { key: "in", format: "money", align: "end" }]}
      filterableBy={["label"]} emptyState="No periods" caption="Cash flow"/>
    <CardList items={cashflow.data} titleField="label" fields={[{ key: "in", label: "In", format: "money" }]} columns={2}/>
    <Money amount={cashflow.data.reduce((total, row) => total + row.in, 0) / 100} currency="USD"/>
    <Percent value={0.42} fractionDigits={1}/>
    <Num value={12} notation="compact"/>
    <DateTime value="2026-01-01" mode="date"/>
    <EnumBadge value="past_due" tones={{ past_due: "danger" }}/>
    <Progress value={0.4} max={1} label="Budget" showValue={true} tone="accent"/>
    <LineChart data={cashflow.data} xKey="label" series={["in", "out"]} format="money" height={220}/>
    <BarChart data={cashflow.data} xKey="label" series={[{ key: "in", label: "In" }]} stacked={true} horizontal={false}/>
    <DonutChart data={cashflow.data} categoryKey="label" valueKey="in" format="money" donut={true}/>
    <Sparkline data={[1, 2, 3]} height={24}/>
    <Callout tone="info" title="Note">Numbers are integer cents.</Callout>
    <Surface title="Detail"><Text text="Nested"/></Surface>
    <Select label="Period" options={cashflow.data} labelField="label" valueField="label" multiple={false}/>
    <Input label="Search" type="search" onChange="host_search"/>
    <DatePicker label="From" min="2026-01-01"/>
    <Form onSubmit="host_note" submitLabel="Save"><Textarea label="Note" rows={3}/><Checkbox label="Pin"/></Form>
    <Button label="Refresh" onClick="host_getCashflowInsights" variant="primary"/>
    <Tabs tabs={["In", "Out"]} value="In"><Text text="Money in"/><Text text="Money out"/></Tabs>
    <Disclaimer reason="No tool exposes forecasts." title="Not shown"/>
    <Text text="Grouped" pending={true}/>
    <Sparkline data={cashflow.data.map((row) => ({ label: row.label, value: row.in }))} valueKey="value"/>
  </Stack>
</App>;
`;

describe("the vocabulary a good screen may name", () => {
  it("reports nothing at all about a broad, correct screen", () => {
    expect(screenTscFindings({ screen: BROAD_SCREEN, typings })).toEqual([]);
  });

  it("names every wire component in the broad screen, so a missing declaration cannot hide", () => {
    // If this drifts, the screen above stops covering a component and the
    // false-positive gate silently narrows.
    const named = new Set([...BROAD_SCREEN.matchAll(/<([A-Z][A-Za-z0-9]*)/gu)].map((match) => match[1]));
    const uncovered = WIRE_COMPONENT_NAMES.filter((name) => !named.has(name));
    expect(uncovered, "add these to BROAD_SCREEN").toEqual([]);
  });

  it("covers the one component family — the Kit wire set IS the vocabulary", () => {
    expect(KIT_WIRE_COMPONENT_NAMES.length).toBeGreaterThan(0);
    expect([...WIRE_COMPONENT_NAMES].sort()).toEqual([...KIT_WIRE_COMPONENT_NAMES].sort());
  });
});
