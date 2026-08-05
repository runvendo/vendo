import { describe, expect, it } from "vitest";
import { compileWire, type WireCompileOptions } from "./compile.js";
import { printWire } from "./print.js";

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
      <LineChart title="Revenue" points={asPoints(revenue.rows, "month", "revenue")}/>
      <DataTable rows={payments} columns={[{ key: "amount", label: "Amount" }]} dense/>
      <HostCard total={revenue.total} note={format(state.note, "currency")}/>
    </Grid>
    Plain text child survives
    <Button label="Remind" onClick="fn:send_reminder"/>
  </Stack>
  <Island name="RevenueNote">export default function RevenueNote() { return <em>ok</em>; }</Island>
</App>`;

const roundTrip = (wire: string): void => {
  const first = compileWire(wire, OPTIONS);
  expect(first.issues).toEqual([]);
  const printed = printWire(first, { includeIds: false });
  const second = compileWire(printed, OPTIONS);
  expect(second.issues).toEqual([]);
  expect(second.tree).toStrictEqual(first.tree);
  expect(second.components).toStrictEqual(first.components);
  expect(second.name).toStrictEqual(first.name);
  expect(second.complete).toBe(true);
};

/** Three declared queries plus one `<Card>` carrying the attributes under
 *  test — the smallest wire that exercises every binding/expression form. */
const cardWire = (attrs: string): string =>
  `<App><Query id="q" tool="t"/><Query id="revenue" tool="metrics.revenue"/>`
  + `<Query id="invoices" tool="invoices.list"/><Card ${attrs}/></App>`;

/** Round-trips `attrs` on a Card and returns the Card's compiled props, so a
 *  case asserts BOTH the law and the shape the law is protecting. */
const roundTripProps = (attrs: string): Record<string, unknown> => {
  const wire = cardWire(attrs);
  roundTrip(wire);
  const compiled = compileWire(wire, OPTIONS);
  return (compiled.tree.nodes.find((node) => node.component === "Card")?.props ?? {}) as Record<string, unknown>;
};

/** The printed form of `attrs` on a Card (the exact bytes the model edits). */
const printedCard = (attrs: string): string => {
  const printed = printWire(compileWire(cardWire(attrs), OPTIONS), { includeIds: false });
  return printed.split("\n").find((line) => line.includes("<Card")) ?? "";
};

describe("printWire round trip", () => {
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
    const first = printWire(compileWire(SPEC_WIRE, OPTIONS), { includeIds: false });
    const second = printWire(compileWire(first, OPTIONS), { includeIds: false });
    expect(second).toBe(first);
  });
});

describe("printWire id anchors", () => {
  it("includeIds stamps every element with its compiler-minted id", () => {
    const result = compileWire(SPEC_WIRE, OPTIONS);
    const printed = printWire(result, { includeIds: true });
    expect(printed).toContain('<LineChart id="linechart-1"');
    expect(printed).toContain('<Stack id="stack-1"');
    // The annotated form is model CONTEXT: recompiling it yields the same
    // tree; the ids surface only as the create compiler's wire-id-ignored.
    const recompiled = compileWire(printed, OPTIONS);
    expect(recompiled.tree).toStrictEqual(result.tree);
    expect(new Set(recompiled.issues.map((issue) => issue.code))).toEqual(new Set(["wire-id-ignored"]));
  });
});

describe("printWire forms", () => {
  it("prints actions back in string form and true as a bare attribute", () => {
    const result = compileWire('<App><Button dense onClick="fn:send_reminder"/></App>');
    const printed = printWire(result, { includeIds: false });
    expect(printed).toContain('onClick="fn:send_reminder"');
    expect(printed).toContain("<Button dense ");
  });

  it("prints unsafe text (angle brackets) as an explicit Text element", () => {
    const result = compileWire("<App><Card/></App>");
    const tree = structuredClone(result.tree);
    tree.nodes.push({ id: "text-1", component: "Text", source: "prewired", props: { text: "a < b" } });
    (tree.nodes[0] as { children?: string[] }).children = ["card-1", "text-1"];
    const printed = printWire({ ...result, tree }, { includeIds: false });
    expect(printed).toContain('<Text text="a < b"/>');
    const recompiled = compileWire(printed);
    expect(recompiled.tree).toStrictEqual(tree);
  });

  it("prints text carrying braces as an explicit Text element (D5's inverse)", () => {
    // Bare text would recompile as `braces-in-text` and vanish, so the printer
    // must fall to the attribute form — the two halves of D5 in lockstep.
    const result = compileWire("<App><Card/></App>");
    const tree = structuredClone(result.tree);
    tree.nodes.push({ id: "text-1", component: "Text", source: "prewired", props: { text: "Total: {q.f}" } });
    (tree.nodes[0] as { children?: string[] }).children = ["card-1", "text-1"];
    const printed = printWire({ ...result, tree }, { includeIds: false });
    expect(printed).toContain('<Text text="Total: {q.f}"/>');
    const recompiled = compileWire(printed);
    expect(recompiled.issues).toEqual([]);
    expect(recompiled.tree).toStrictEqual(tree);
  });

  it("prints no comments back, because compiler output carries none (D4)", () => {
    const wire = '<App name="C">{/* a note */}<Card/>{/* another */}</App>';
    const compiled = compileWire(wire, OPTIONS);
    expect(compiled.issues).toEqual([]);
    const printed = printWire(compiled, { includeIds: false });
    expect(printed).not.toContain("/*");
    expect(compileWire(printed, OPTIONS).tree).toStrictEqual(compiled.tree);
  });

  it("prints a binding it cannot express as a reference via the object fallback", () => {
    const base = compileWire('<App><Query id="q" tool="t"/><Card v={q.rows}/></App>');
    const tree = structuredClone(base.tree);
    const card = tree.nodes.find((node) => node.id === "card-1");
    (card as { props?: Record<string, unknown> }).props = { v: { $path: "/undeclared/field" } };
    const printed = printWire({ ...base, tree }, { includeIds: false });
    expect(printed).toContain('"$path"');
    const recompiled = compileWire(printed);
    expect(recompiled.tree).toStrictEqual(tree);
  });
});

describe("printWire totality fallbacks", () => {
  it("prints non-Json prop values as null instead of throwing", () => {
    const base = compileWire("<App><Card/></App>");
    const tree = structuredClone(base.tree);
    (tree.nodes[1] as { props?: Record<string, unknown> }).props = { broken: undefined };
    const printed = printWire({ ...base, tree: tree as typeof base.tree }, { includeIds: false });
    expect(printed).toContain("broken={null}");
  });
});

describe("printWire computed values", () => {
  it("round-trips a { $expr } prop as its own source", () => {
    const wire = '<App><Query id="invoices" tool="invoices.list"/>'
      + '<Stat value={sum(invoices.data, "amount_cents") / count(invoices.data)}/></App>';
    const compiled = compileWire(wire);
    expect(compiled.issues).toEqual([]);
    expect(compiled.tree.nodes.find((node) => node.component === "Stat")?.props)
      .toStrictEqual({ value: { $expr: 'sum(invoices.data, "amount_cents") / count(invoices.data)' } });
    const printed = printWire(compiled, { includeIds: false });
    expect(printed).toContain('value={sum(invoices.data, "amount_cents") / count(invoices.data)}');
    expect(compileWire(printed).tree).toStrictEqual(compiled.tree);
  });

  it("falls back to the object literal for an $expr source that no longer parses", () => {
    const base = compileWire('<App><Query id="q" tool="t"/><Card v={q.rows}/></App>');
    const tree = structuredClone(base.tree);
    const card = tree.nodes.find((node) => node.id === "card-1");
    (card as { props?: Record<string, unknown> }).props = { v: { $expr: "sum(" } };
    const printed = printWire({ ...base, tree }, { includeIds: false });
    expect(printed).toContain('"$expr"');
    expect(compileWire(printed).tree).toStrictEqual(tree);
  });
});

/**
 * D1/D2/D3 (v3 spec §5) — the dialect is a strict TSX subset: a reshape is a
 * NESTED CALL with the value first, an aggregate names its field explicitly,
 * and `group_by` takes a rows argument plus an aggregate descriptor. The
 * printer is the inverse, under the same byte-identical round-trip law.
 */
describe("printWire nested-call dialect", () => {
  it("compiles a reshape as a value-first call and prints it back identically", () => {
    expect(roundTripProps('points={asPoints(revenue.rows, "month", "revenue")}')).toStrictEqual({
      points: { $path: "/revenue/rows", $reshape: [{ op: "asPoints", args: ["month", "revenue"] }] },
    });
    expect(printedCard('points={asPoints(revenue.rows, "month", "revenue")}'))
      .toContain('points={asPoints(revenue.rows, "month", "revenue")}');
  });

  it("nests a chain innermost-first and prints the nesting back in step order", () => {
    const attrs = 'rows={rename(pick(revenue.rows, "month", "revenue"), "month", "label")}';
    expect(roundTripProps(attrs)).toStrictEqual({
      rows: {
        $path: "/revenue/rows",
        $reshape: [
          { op: "pick", args: ["month", "revenue"] },
          { op: "rename", args: ["month", "label"] },
        ],
      },
    });
    expect(printedCard(attrs)).toContain(attrs);
  });

  it("chains over a state binding", () => {
    expect(roundTripProps('note={format(state.note, "currency")}')).toStrictEqual({
      note: { $state: "note", $reshape: [{ op: "format", args: ["currency"] }] },
    });
  });

  it("round-trips a max-length (8-step) nested chain", () => {
    const chain = 'rename(rename(rename(rename(rename(rename(rename(pick(q.rows, "a", "b"),'
      + ' "a", "c"), "c", "d"), "d", "e"), "e", "f"), "f", "g"), "g", "h"), "h", "i")';
    const props = roundTripProps(`v={${chain}}`);
    expect((props.v as { $reshape: unknown[] }).$reshape).toHaveLength(8);
    expect(printedCard(`v={${chain}}`)).toContain(chain);
  });

  it("always quotes reshape arguments, including ones that need it", () => {
    expect(roundTripProps('v={pick(q.rows, "weird field")}')).toStrictEqual({
      v: { $path: "/q/rows", $reshape: [{ op: "pick", args: ["weird field"] }] },
    });
    expect(printedCard('v={pick(q.rows, "weird field")}')).toContain('pick(q.rows, "weird field")');
  });

  it("takes an explicit field on every aggregate (D2)", () => {
    expect(roundTripProps('value={sum(invoices.data, "amount_cents")}')).toStrictEqual({
      value: { $expr: 'sum(invoices.data, "amount_cents")' },
    });
    roundTripProps("count={count(invoices.data)}");
    roundTripProps('avg={average(invoices.data, "amount_cents")}');
    roundTripProps('lo={min(invoices.data, "amount_cents")} hi={max(invoices.data, "amount_cents")}');
  });

  it("round-trips arithmetic, difference, negation and days_until over aggregates", () => {
    roundTripProps('value={sum(invoices.data, "amount_cents") / count(invoices.data)}');
    roundTripProps('d={difference(sum(q.rows, "x"), sum(revenue.rows, "x"))}');
    roundTripProps('n={-sum(q.rows, "x")}');
    roundTripProps("u={days_until(invoices.due_date) * 2}");
    roundTripProps('big={((sum(q.rows, "x") - sum(revenue.rows, "x")) / count(q.rows)) * 100}');
  });

  it("round-trips group_by's descriptor form (D3)", () => {
    expect(roundTripProps('points={group_by(invoices.data, "issued_at", "month", sum.of("total_cents"))}'))
      .toStrictEqual({ points: { $expr: 'group_by(invoices.data, "issued_at", "month", sum.of("total_cents"))' } });
    roundTripProps('points={group_by(invoices.data, "issued_at", "day", count.of())}');
  });

  it("round-trips calls nested inside array and object literals", () => {
    roundTripProps('v={[count(q.rows), 5]} w={{ total: sum(q.rows, "amount") }}');
    roundTripProps('v={[pick(q.rows, "a"), 5]}');
  });

  it("round-trips an aggregate whose interior spacing is not canonical", () => {
    expect(printedCard('v={sum( invoices.data , "amount_cents" )}'))
      .toContain('v={sum( invoices.data , "amount_cents" )}');
    roundTripProps('v={sum( invoices.data , "amount_cents" )}');
  });
});
