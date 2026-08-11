import { describe, expect, it, beforeAll } from "vitest";
import { compileWire, type WireCompileOptions } from "../../../../src/contract/genui/wire/compile.js";
import { evaluateExpr, isExprBinding, warmExprRuntime } from "../../../../src/contract/genui/expr.js";
import { exprIssues, queryInputIssues, unknownToolIssues } from "../../../../src/server/checking/facts.js";
import type { Tree } from "../../../../src/contract/genui/tree.js";

/**
 * A `{...}` gap is a JavaScript expression, so a prop can carry a CALL — and a
 * call is a formula, never a fetch. Only a literal `<Query tool="…"/>` may
 * create a query.
 *
 * The document below is real model output the bench caught. The inline-tool-ref
 * pre-pass (wire/inline-refs.ts) read every dotted chain before `(` as a tool
 * call, so `spending.data.reduce(…)` and `spending.data.map(…)` each minted a
 * phantom `<Query id="spendingDataReduce" tool="spending.data.reduce">` with the
 * arrow function smuggled into its `input`. Three blocking findings followed
 * from one correct total: `tools-exist` ("names unknown tool
 * spending.data.reduce"), `query-inputs-literal` on both phantoms, and
 * `screen-types` comma-operator complaints on the phantom inputs.
 *
 * This runs the real SEAM: the producer is `compileWire` with the production
 * options (`inlineRefs` on, the registry supplied), the consumer is the real
 * `evaluateExpr` in its real interpreter. Neither side is stubbed, so they
 * cannot agree with each other about a shape the renderer would reject.
 */
const DOCUMENT = `<App name="Spending this month">
  <Query id="spending" tool="get_spending"/>
  <Stat label="Total spent" value={spending.data.reduce((t, c) => t + c.amount, 0) / 100} format="money"/>
  <DonutChart data={spending.data.map(c => ({ category: c.category, amount: c.amount / 100 }))} categoryKey="category" valueKey="amount" format="money" emptyState="No spending recorded this month"/>
  <DataTable rows={spending.data.map(c => ({ category: c.category, amount: c.amount / 100 }))} sortBy="amount desc" columns={[{key:"category",label:"Category"},{key:"amount",label:"Amount",format:"money",align:"end"}]} emptyState="No spending recorded this month"/>
</App>`;

/** The production compile options (server/runtime/wire-options.ts): inline refs
 *  on, with the host registry naming the one real tool. */
const OPTIONS: WireCompileOptions = { inlineRefs: true, inlineTools: ["get_spending"] };

const DATA = {
  spending: {
    data: [
      { category: "Groceries", amount: 12_050 },
      { category: "Transport", amount: 4_300 },
    ],
  },
};

const computedProps = (result: ReturnType<typeof compileWire>): Array<[string, string]> =>
  result.tree.nodes.flatMap((node) =>
    Object.entries(node.props ?? {})
      .filter(([, value]) => isExprBinding(value))
      .map(([prop, value]) => [`${node.component}.${prop}`, (value as { $expr: string }).$expr] as [string, string]));

describe("a JavaScript call in a prop is a formula, not a query", () => {
  beforeAll(async () => {
    await warmExprRuntime();
  });

  it("compiles the document clean", () => {
    expect(compileWire(DOCUMENT, OPTIONS).issues).toEqual([]);
  });

  it("produces none of the three findings that blocked it", () => {
    // These are the fact checks that actually blocked the bench — the compiler
    // itself was already quiet, which is why the phantom queries reached them.
    const tree = compileWire(DOCUMENT, OPTIONS).tree as Tree;
    expect(unknownToolIssues(tree, [{ name: "get_spending", description: "this month's spending", risk: "read" }])).toEqual([]);
    expect(queryInputIssues(tree)).toEqual([]);
    expect(exprIssues(tree)).toEqual([]);
  });

  it("declares EXACTLY the one query the document wrote", () => {
    const { tree } = compileWire(DOCUMENT, OPTIONS);
    expect(tree.queries).toEqual([{ name: "spending", tool: "get_spending" }]);
  });

  it("lands all three computed props as $expr carrying their own source", () => {
    expect(computedProps(compileWire(DOCUMENT, OPTIONS))).toEqual([
      ["Stat.value", "spending.data.reduce((t, c) => t + c.amount, 0) / 100"],
      ["DonutChart.data", "spending.data.map(c => ({ category: c.category, amount: c.amount / 100 }))"],
      ["DataTable.rows", "spending.data.map(c => ({ category: c.category, amount: c.amount / 100 }))"],
    ]);
  });

  it("evaluates every computed prop to the value the screen would show", () => {
    const values = computedProps(compileWire(DOCUMENT, OPTIONS))
      .map(([where, source]) => [where, evaluateExpr(source, DATA)] as const);
    // Every one resolves — a thrown or unparsed expression is the blank-stat
    // class this document shipped as.
    for (const [where, result] of values) {
      expect(result, where).toEqual(expect.objectContaining({ ok: true }));
    }
    expect(values.map(([, result]) => (result.ok ? result.value : result.issue))).toEqual([
      163.5,
      [{ category: "Groceries", amount: 120.5 }, { category: "Transport", amount: 43 }],
      [{ category: "Groceries", amount: 120.5 }, { category: "Transport", amount: 43 }],
    ]);
  });

  it("still expands a REAL inline tool reference — the root is not a query", () => {
    const { tree, issues } = compileWire(
      `<App name="x"><DataTable rows={invoices.list({status:"overdue"}).data}/></App>`,
      { inlineRefs: true, inlineTools: ["invoices.list"] },
    );
    expect(issues).toEqual([]);
    expect(tree.queries).toEqual([
      { name: "invoicesList", tool: "invoices.list", input: { status: "overdue" } },
    ]);
  });

  it("mints nothing for a call the tool registry does not name", () => {
    // The gate that closed the bug: an unknown dotted head is left alone, so it
    // stays a formula instead of becoming a query for a tool nobody has.
    const { tree } = compileWire(
      `<App name="x"><Query id="q" tool="get_spending"/><Stat value={q.data.map(r => r.n).length}/></App>`,
      OPTIONS,
    );
    expect(tree.queries).toEqual([{ name: "q", tool: "get_spending" }]);
    expect(computedProps({ tree } as ReturnType<typeof compileWire>)).toEqual([
      ["Stat.value", "q.data.map(r => r.n).length"],
    ]);
  });
});
