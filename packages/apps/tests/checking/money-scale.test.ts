/**
 * Money slots take integer CENTS and format them themselves
 * (`formatMoney(cents)`, packages/ui/src/kit/format.ts:105). A host field named
 * `balance` rather than `balance_cents` reads to a writer as dollars, so it
 * scales the expression down — and the formatter divides by 100 again. A
 * $36,265.00 net worth ships as "$362.65": bound to real rows, so every shape
 * and expression check passes, and no reader can tell it is wrong.
 *
 * Measured over the generation corpus, this ONE pattern was every honest-data
 * floor failure the app writer produced. The check runs from the compiled tree,
 * not from the source text, so it sees what the renderer will see.
 */
import { describe, expect, it } from "vitest";
import { compileWire } from "../../src/contract/genui/wire/compile.js";
import { moneyScaleIssues } from "../../src/server/checking/facts.js";

const issuesFor = (wire: string): string[] => {
  const compiled = compileWire(wire);
  expect(compiled.issues).toEqual([]);
  return moneyScaleIssues(compiled.tree).map((issue) => `${issue.where} ${issue.message}`);
};

const app = (body: string) =>
  `<App name="Accounts"><Query id="accounts" tool="list_accounts"/>${body}</App>`;

describe("a money slot never takes a scaled expression", () => {
  it("reports the /100 that renders the amount 100x too small", () => {
    const issues = issuesFor(app('<Stat label="Net worth" value={sum(accounts.data, "balance") / 100} format="money"/>'));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('prop "value"');
    expect(issues[0]).toContain("integer CENTS");
  });

  it("reports the * 0.01 spelling of the same mistake", () => {
    expect(issuesFor(app('<Stat label="Net worth" value={sum(accounts.data, "balance") * 0.01} format="money"/>'))).toHaveLength(1);
  });

  it("passes the cents bound straight through", () => {
    expect(issuesFor(app('<Stat label="Net worth" value={sum(accounts.data, "balance")} format="money"/>'))).toEqual([]);
  });

  it("leaves a divisor that is not the cents scale alone", () => {
    expect(issuesFor(app('<Stat label="Average" value={sum(accounts.data, "balance") / count(accounts.data)} format="money"/>'))).toEqual([]);
  });

  it("leaves a scale on a slot that is not money alone", () => {
    expect(issuesFor(app('<Stat label="Accounts" value={count(accounts.data) / 100} format="number"/>'))).toEqual([]);
  });
});
