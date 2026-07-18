import { describe, expect, it } from "vitest";
import { componentMapError } from "../component-map.js";
import { validateTreeV2 } from "../tree-v2.js";
import { compileWireV2 } from "./compile.js";

/**
 * D6 valid-while-partial property (v2 spec §2, plan Task 5): for EVERY prefix
 * length of a rich fixture — every character boundary, not samples — the
 * compiler must
 *  - never throw (compileWireV2 catches internally and degrades to a
 *    `compile-failed` issue, so the sweep asserts that issue never appears:
 *    a hidden throw cannot masquerade as success),
 *  - emit a tree that passes validateTreeV2,
 *  - emit components that pass componentMapError,
 *  - report `complete` false for every proper prefix and true only at full
 *    length (the fixtures end exactly at `</App>` to make that sharp), and
 *  - keep the node count monotonically non-decreasing as the prefix grows
 *    (plateaus allowed, decreases forbidden): a truncated trailing tag,
 *    attribute, or expression drops only ITS OWN element, never an earlier
 *    node.
 */

/** Rich but compact (~1.2 KB, the sweep is O(n²)): queries with input
 *  expressions incl. a forward reference, nested components, escapes,
 *  negative/decimal numbers, text children, all three action forms, and an
 *  island whose raw TSX carries quotes, braces, and tags. Ends exactly at
 *  `</App>` — no trailing whitespace — so `complete` flips only at full
 *  length. */
const FIXTURE = `<App name="Cash Overview">
  <Query id="revenue" tool="metrics.revenue" input={{ months: 6, tags: ["net", 'gross'] }}/>
  <Stack gap={16}>
    <PageHeader title="Cash \\"Overview\\"" subtitle="Live cash position" compact/>
    <Grid cols={3}>
      <LineChart title="Revenue" points={revenue}/>
      <DataTable rows={payments} columns={[{ key: "amount", label: "Amount" }]} dense/>
      <Stat label="Total" value={12500.75} delta={-3}/>
    </Grid>
    <Card>
      Cash is healthy this month.
      <Badge tone="positive">on track</Badge>
      <Button onClick="export_csv" onRetry="fn:reload_data" onOpen={{ action: "fn:open_detail", confirm: true }}>Export</Button>
    </Card>
    <RevenueNote/>
  </Stack>
  <Island name="RevenueNote">export default function RevenueNote() { if (1 < 2) { return <em>Cash "is" healthy.</em>; } }</Island>
  <Query id="payments" tool="payments.list" input={{ limit: 5 }}/>
</App>`;

/** The Task 4 pathological probe — a single-quoted attribute value hiding
 *  fake declarations — injected mid-fixture to prove partial + hostile
 *  composes. */
const HOSTILE = FIXTURE.replace(
  "<RevenueNote/>",
  "<Widget a='> <Island name=\"Fake\">x</Island> <Query id=\"ghost\" tool=\"t\"/> '/><RevenueNote/>",
);

const sweepPrefixes = (wire: string): void => {
  const problems: string[] = [];
  let previousNodeCount = 0;
  for (let length = 0; length <= wire.length; length += 1) {
    const result = compileWireV2(wire.slice(0, length));
    if (result.issues.some((entry) => entry.code === "compile-failed")) {
      problems.push(`len ${length}: compileWireV2 threw internally (compile-failed)`);
    }
    const validation = validateTreeV2(result.tree);
    if (!validation.ok) {
      problems.push(`len ${length}: tree invalid — ${validation.error.message}`);
    }
    const mapError = componentMapError(result.components);
    if (mapError !== null) {
      problems.push(`len ${length}: components invalid — ${mapError}`);
    }
    const expectedComplete = length === wire.length;
    if (result.complete !== expectedComplete) {
      problems.push(`len ${length}: complete was ${String(result.complete)}, expected ${String(expectedComplete)}`);
    }
    const nodeCount = result.tree.nodes.length;
    if (nodeCount < previousNodeCount) {
      problems.push(`len ${length}: node count fell ${previousNodeCount} -> ${nodeCount}`);
    }
    previousNodeCount = nodeCount;
  }
  expect(problems).toEqual([]);
};

describe("compileWireV2 valid-while-partial property (D6)", () => {
  it("compiles the full fixture clean (the sweep's endpoint is a real document)", () => {
    const result = compileWireV2(FIXTURE);
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.name).toBe("Cash Overview");
    expect(result.tree.queries?.map((query) => query.name)).toEqual(["revenue", "payments"]);
    expect(Object.keys(result.components)).toEqual(["RevenueNote"]);
    // The forward reference resolved and the island-backed usage is generated.
    const note = result.tree.nodes.find((node) => node.component === "RevenueNote");
    expect(note?.source).toBe("generated");
    const table = result.tree.nodes.find((node) => node.component === "DataTable");
    expect(table?.props?.rows).toStrictEqual({ $path: "/payments" });
  });

  it("holds across every prefix of the rich fixture", () => {
    sweepPrefixes(FIXTURE);
  });

  it("holds across every prefix with the injected hostile single-quoted segment", () => {
    sweepPrefixes(HOSTILE);
  });

  it("keeps the hostile segment inert at full length (no phantom declarations)", () => {
    const result = compileWireV2(HOSTILE);
    expect(result.complete).toBe(true);
    expect(Object.keys(result.components)).toEqual(["RevenueNote"]);
    expect(result.tree.queries?.map((query) => query.name)).toEqual(["revenue", "payments"]);
    const widget = result.tree.nodes.find((node) => node.component === "Widget");
    expect(widget).toStrictEqual({ id: "widget-1", component: "Widget" });
    expect(result.issues.map((entry) => entry.code)).toEqual(["malformed-attribute"]);
  });
});
