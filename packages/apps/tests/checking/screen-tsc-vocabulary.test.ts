/**
 * The false-positive gate.
 *
 * A check that blocks a GOOD screen is worse than no check: it stops a shipping
 * app on the strength of a hole in the generator. So one broad screen exercises
 * the whole vocabulary at once — every screen component, the aggregate calls, a
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
  KIT_SCREEN_COMPONENT_NAMES,
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

/** Every screen component, the computed forms a screen really writes (a `{...}`
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
      <Stat label="Money in" value={cashflow.data.reduce((total, row) => total + row.in, 0) / 100} unit="USD"/>
      <Stat label="Money out" value={cashflow.data.reduce((total, row) => total + row.out, 0) / cashflow.data.length / 100} unit="USD"/>
      <Stat label="Periods" value={cashflow.data.length}/>
      <Stat label="Spread" value={cashflow.data.reduce((top, row) => (row.in > top ? row.in : top), 0) - cashflow.data.reduce((low, row) => (row.out < low ? row.out : low), 0)}/>
    </Row>
    <Grid columns={2}>
      <MapleNetWorthCard valueCents={cashflow.data.reduce((total, row) => total + row.in, 0)} series={[1, 2, 3]} initialRange="1M"/>
      <Card title="Detail" description="This period" tone="accent"><Divider/><Badge label="Live" tone="accent"/></Card>
    </Grid>
    <SplitPane size={280}><Text text="Periods"/><Text text="This period"/></SplitPane>
    <DataTable rows={cashflow.data} sortBy="label asc" limit={20} searchable={true} paginate={10}
      columns={[{ key: "label", label: "Period" }, { key: "in", align: "end", truncate: true, width: 160 }]}
      filterableBy={["label"]} emptyState="No periods" caption="Cash flow"/>
    <DataTable rows={cashflow.data} columns={[{ key: "label", label: "Period" }, { key: "in", label: "In", align: "end" }]}>
      <TableRow><Text text="Period"/><Text text="$42.00"/></TableRow>
    </DataTable>
    <CardList items={cashflow.data} titleField="label" fields={[{ key: "in", label: "In" }]} columns={2}/>
    <Calendar items={cashflow.data} month="2026-01" dateField="label" titleField="label" amountField="in" statusField="label" tones={{ Jan: "success" }}/>
    <KeyValue record={cashflow.data[0]} items={[{ key: "label", label: "Period" }, { key: "in" }]} dividers={true}/>
    <Timeline entries={cashflow.data} titleField="label" emptyState="No history"/>
    <Avatar name="Ada Lovelace" size="sm"/>
    <CodeBlock language="json" code="const rate = 0.42;"/>
    <EnumBadge value="past_due" tones={{ past_due: "danger" }}/>
    <Icon name="trending-up" size={20} label="Trending up"/>
    <Progress value={0.4} max={1} label="Budget" showValue={true} tone="accent"/>
    <LineChart data={cashflow.data} xKey="label" series={["in", "out"]} xFormat={["Jan", "Feb"]} height={220}/>
    <BarChart data={cashflow.data} xKey="label" series={[{ key: "in", label: "In" }]} stacked={true} horizontal={false}/>
    <DonutChart data={cashflow.data} categoryKey="label" valueKey="in" format={["$42.00", "$18.00"]} donut={true}/>
    <Sparkline data={[1, 2, 3]} height={24}/>
    <Callout tone="info" title="Note">Numbers are integer cents.</Callout>
    <Accordion items={[{ label: "Terms", content: <Text text="Net 30."/> }]} multiple={false} defaultOpen={[0]}/>
    <Surface title="Detail"><Text text="Nested"/></Surface>
    <Select label="Period" options={cashflow.data} labelField="label" valueField="label" multiple={false}/>
    <Input label="Search" type="search" onChange="host_search"/>
    <DatePicker label="From" min="2026-01-01"/>
    <DateRange label="Period" start="2026-01-01" end="2026-03-01" min="2025-01-01" max="2026-12-31" placeholder="Pick a range" onChange="host_period"/>
    <Combobox label="Client" options={cashflow.data} labelField="label" valueField="label" value="Jan" placeholder="Search" onChange="host_client"/>
    <Radio label="Plan" options={cashflow.data} labelField="label" valueField="label" value="Jan" onChange="host_plan"/>
    <SegmentedControl items={["Week", "Month"]} value="Week" onChange="host_range"/>
    <Slider label="Budget" value={40} min={0} max={100} step={5} showValue={true} onChange="host_budget"/>
    <Menu label="Actions" items={[{ label: "Send reminder", value: "remind", icon: "send" }, { label: "Void", disabled: true }]} onSelect="host_action"/>
    <Tooltip label="Sent 3 days ago"><Icon name="clock"/></Tooltip>
    <Form onSubmit="host_note" submitLabel="Save"><Textarea label="Note" rows={3}/><Checkbox label="Pin"/><Switch label="Notify" checked={true} onChange="host_notify"/></Form>
    <Button label="Refresh" onClick="host_getCashflowInsights" variant="primary"/>
    <Link to="account" params={{ id: cashflow.data[0].label }} label="View account"/>
    <Tabs tabs={["In", "Out"]} value="In"><Text text="Money in"/><Text text="Money out"/></Tabs>
    <Disclaimer reason="No tool exposes forecasts." title="Not shown"/>
    <EmptyState icon="inbox" title="No periods" description="They appear the moment one closes."><Button label="Refresh" onClick="host_getCashflowInsights"/></EmptyState>
    <Steps items={[{ label: "Details" }, { label: "Review", description: "Check the totals" }, { label: "Done" }]} active={1}/>
    <Modal open={false} onClose="host_search" title="Confirm" description="Send reminders?" size="medium"><Text text="Body"/></Modal>
    <Sheet open={false} onClose="host_search" title="Detail" side="right" size="medium"><Text text="Body"/></Sheet>
    <Toast open={false} onClose="host_search" message="Saved." tone="success" duration={4000}/>
    <Text text="Grouped" pending={true}/>
    <Sparkline data={cashflow.data.map((row) => ({ label: row.label, value: row.in }))} valueKey="value"/>
  </Stack>
</App>;
`;

describe("the vocabulary a good screen may name", () => {
  it("reports nothing at all about a broad, correct screen", () => {
    expect(screenTscFindings({ screen: BROAD_SCREEN, typings })).toEqual([]);
  });

  it("names every screen component in the broad screen, so a missing declaration cannot hide", () => {
    // If this drifts, the screen above stops covering a component and the
    // false-positive gate silently narrows.
    const named = new Set([...BROAD_SCREEN.matchAll(/<([A-Z][A-Za-z0-9]*)/gu)].map((match) => match[1]));
    const uncovered = KIT_SCREEN_COMPONENT_NAMES.filter((name) => !named.has(name));
    expect(uncovered, "add these to BROAD_SCREEN").toEqual([]);
  });
});
