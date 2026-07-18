import { describe, expect, it } from "vitest";
import { compileWireV2, type WireCompileOptions } from "./compile.js";
import { printWireV2 } from "./print.js";

/** v2 spec §5 — the printer is the model's edit context: a compile result
 *  prints back to wire markup, and the round trip is exact for anything the
 *  compiler produced. */

const OPTIONS: WireCompileOptions = { hostComponents: ["HostCard"] };

const SPEC_WIRE = `<App name="Cash Overview">
  <Query id="revenue" tool="metrics.revenue"/>
  <Query id="payments" tool="payments.list" input={{ limit: 5 }}/>
  <Stack gap={16}>
    <PageHeader title="Cash Overview" subtitle="Says \\"hi\\" \\\\ done"/>
    <Grid cols={3}>
      <LineChart title="Revenue" points={revenue.rows | asPoints(month, revenue)}/>
      <DataTable rows={payments} columns={[{ key: "amount", label: "Amount" }]} dense/>
      <HostCard total={revenue.total} note={state.note | format(currency)}/>
    </Grid>
    Plain text child survives
    <Button label="Remind" onClick="fn:send_reminder"/>
  </Stack>
  <Island name="RevenueNote">export default function RevenueNote() { return <em>ok</em>; }</Island>
</App>`;

const roundTrip = (wire: string): void => {
  const first = compileWireV2(wire, OPTIONS);
  expect(first.issues).toEqual([]);
  const printed = printWireV2(first, { includeIds: false });
  const second = compileWireV2(printed, OPTIONS);
  expect(second.issues).toEqual([]);
  expect(second.tree).toStrictEqual(first.tree);
  expect(second.components).toStrictEqual(first.components);
  expect(second.name).toStrictEqual(first.name);
  expect(second.complete).toBe(true);
};

describe("printWireV2 round trip", () => {
  it("round-trips the full spec-shaped wire byte-identically (tree, components, name)", () => {
    roundTrip(SPEC_WIRE);
  });

  it("round-trips minimal, name-less, and value-heavy wires", () => {
    roundTrip("<App><Card/></App>");
    roundTrip('<App name="X"/>');
    roundTrip('<App><Card a={null} b={false} c={-2.5} d={[1, "two", { nested: true }]} e="s"/></App>');
    roundTrip('<App><Text text="explicit" variant="heading"/></App>');
    roundTrip("<App><Stack>  trimmed   text  </Stack></App>");
  });

  it("round-trips negative zero and quoted object keys", () => {
    roundTrip('<App><Card z={-0} m={{ "weird key": 1, ok: 2 }}/></App>');
  });

  it("is deterministic: print(compile(print(x))) === print(compile(x))", () => {
    const first = printWireV2(compileWireV2(SPEC_WIRE, OPTIONS), { includeIds: false });
    const second = printWireV2(compileWireV2(first, OPTIONS), { includeIds: false });
    expect(second).toBe(first);
  });
});

describe("printWireV2 id anchors", () => {
  it("includeIds stamps every element with its compiler-minted id", () => {
    const result = compileWireV2(SPEC_WIRE, OPTIONS);
    const printed = printWireV2(result, { includeIds: true });
    expect(printed).toContain('<LineChart id="linechart-1"');
    expect(printed).toContain('<Stack id="stack-1"');
    // The annotated form is model CONTEXT: recompiling it yields the same
    // tree; the ids surface only as the create compiler's wire-id-ignored.
    const recompiled = compileWireV2(printed, OPTIONS);
    expect(recompiled.tree).toStrictEqual(result.tree);
    expect(new Set(recompiled.issues.map((issue) => issue.code))).toEqual(new Set(["wire-id-ignored"]));
  });
});

describe("printWireV2 forms", () => {
  it("prints actions back in string form and true as a bare attribute", () => {
    const result = compileWireV2('<App><Button dense onClick="fn:send_reminder"/></App>');
    const printed = printWireV2(result, { includeIds: false });
    expect(printed).toContain('onClick="fn:send_reminder"');
    expect(printed).toContain("<Button dense ");
  });

  it("prints unsafe text (angle brackets) as an explicit Text element", () => {
    const result = compileWireV2("<App><Card/></App>");
    const tree = structuredClone(result.tree);
    tree.nodes.push({ id: "text-1", component: "Text", source: "prewired", props: { text: "a < b" } });
    (tree.nodes[0] as { children?: string[] }).children = ["card-1", "text-1"];
    const printed = printWireV2({ ...result, tree }, { includeIds: false });
    expect(printed).toContain('<Text text="a < b"/>');
    const recompiled = compileWireV2(printed);
    expect(recompiled.tree).toStrictEqual(tree);
  });

  it("prints a binding it cannot express as a reference via the object fallback", () => {
    const base = compileWireV2('<App><Query id="q" tool="t"/><Card v={q.rows}/></App>');
    const tree = structuredClone(base.tree);
    const card = tree.nodes.find((node) => node.id === "card-1");
    (card as { props?: Record<string, unknown> }).props = { v: { $path: "/undeclared/field" } };
    const printed = printWireV2({ ...base, tree }, { includeIds: false });
    expect(printed).toContain('"$path"');
    const recompiled = compileWireV2(printed);
    expect(recompiled.tree).toStrictEqual(tree);
  });
});
