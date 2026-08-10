/**
 * The money-scale fact check (checking/facts.ts): a computed value that divides
 * by 100 on its way into a money slot.
 *
 * The defect is measured, not imagined. Across 35 real generations of the maple
 * world the writer wrote `value={sum(spending.data, "amount") / 100}
 * format="money"` on 17 money stats, and since `format="money"` renders integer
 * minor units the $4,243.11 spend total shipped as $42.43 — the same figure the
 * bench then reported as invented data no derivation could reproduce.
 *
 * Every case here goes through the real compiler: the tree under test is what
 * `compileWire` produces from the document text a model would actually write, so
 * the check is exercised against the same `$expr` bindings it meets in
 * production rather than a hand-built lookalike.
 */
import { VENDO_APP_FORMAT, type ShapeType } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { compileWire, type AppDocument } from "../../src/contract/index.js";
import { moneyScaleIssues, treeOf } from "../../src/server/checking/facts.js";

const toolShapes: Record<string, ShapeType> = {
  get_spending: {
    kind: "object",
    fields: {
      data: {
        kind: "array",
        items: { kind: "object", fields: { category: { kind: "string" }, amount: { kind: "number" } } },
      },
    },
  },
};

/** The issues for one app document, compiled the way the engine compiles it. */
const issuesFor = (body: string): string[] => {
  const compiled = compileWire(
    `<App name="Spend"><Query id="spending" tool="get_spending"/>${body}</App>`,
    { toolShapes },
  );
  const document = {
    format: VENDO_APP_FORMAT,
    id: "app_money_scale_test",
    name: compiled.name ?? "Spend",
    ui: "tree",
    tree: compiled.tree as unknown as AppDocument["tree"],
  } as AppDocument;
  const tree = treeOf(document);
  if (tree === undefined) throw new Error("the fixture document did not compile to a tree");
  return moneyScaleIssues(tree).map(({ where, message }) => `${where} ${message}`);
};

describe("money-scale", () => {
  it("blocks the measured defect: a money stat that divides its total by 100", () => {
    const issues = issuesFor(
      '<Stat label="Total spent" value={sum(spending.data, "amount") / 100} format="money"/>',
    );
    expect(issues).toHaveLength(1);
    // The message has to teach both directions, because a model repairs from it
    // and the repair for a whole-units host is the opposite arithmetic.
    expect(issues[0]).toContain('prop "value"');
    expect(issues[0]).toContain("integer minor units");
    expect(issues[0]).toContain("multiply by 100 instead");
  });

  it("blocks `* 0.01`, the same conversion written the other way", () => {
    expect(issuesFor(
      '<Stat label="Total spent" value={sum(spending.data, "amount") * 0.01} format="money"/>',
    )).toHaveLength(1);
  });

  it("blocks the divisor wherever it sits in the expression", () => {
    expect(issuesFor(
      '<Stat label="Average" value={sum(spending.data, "amount") / 100 - min(spending.data, "amount") / 100} format="money"/>',
    )).toHaveLength(1);
    expect(issuesFor(
      '<Money cents={difference(max(spending.data, "amount"), min(spending.data, "amount")) / 100}/>',
    )).toHaveLength(1);
  });

  it("passes the same screen written honestly", () => {
    expect(issuesFor(
      '<Stat label="Total spent" value={sum(spending.data, "amount")} format="money"/>',
    )).toEqual([]);
    expect(issuesFor('<Money cents={sum(spending.data, "amount")}/>')).toEqual([]);
  });

  it("leaves scaling UP alone — it is the repair when a host reports whole units", () => {
    expect(issuesFor(
      '<Stat label="Total spent" value={sum(spending.data, "amount") * 100} format="money"/>',
    )).toEqual([]);
  });

  it("stays out of slots that are not money", () => {
    // A percent slot legitimately divides by 100, and so does a plain number.
    expect(issuesFor(
      '<Stat label="Share" value={sum(spending.data, "amount") / 100} format="percent"/>',
    )).toEqual([]);
    expect(issuesFor(
      '<Stat label="Units" value={sum(spending.data, "amount") / 100} format="number"/>',
    )).toEqual([]);
    expect(issuesFor(
      '<Text text={count(spending.data) / 100}/>',
    )).toEqual([]);
  });

  it("says nothing about a division by anything else", () => {
    expect(issuesFor(
      '<Stat label="Average spend" value={sum(spending.data, "amount") / count(spending.data)} format="money"/>',
    )).toEqual([]);
    expect(issuesFor(
      '<Stat label="Half" value={sum(spending.data, "amount") / 2} format="money"/>',
    )).toEqual([]);
  });

  it("leaves a plain field divided by 100 alone — that is how a rate is read", () => {
    // `state.rate / 100` is a percentage-typed rate, and refusing it would refuse
    // a screen that is right. Only a reduced money figure is the defect's shape.
    expect(issuesFor(
      '<Stat label="Fee" value={sum(spending.data, "amount") * (state.rate / 100)} format="money"/>',
    )).toEqual([]);
  });
});
