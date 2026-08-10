/**
 * The 100x money defect, from both directions. Money is integer cents end to
 * end and every money slot scales to major units itself, so `/ 100` on the way
 * in and `format(…, "currency")` on the way out are each exactly one hundred
 * times wrong — and neither is visible to the raw-type checks, because a number
 * is a number. These run the REAL compiler and the REAL fact, so the wire the
 * corpus actually writes is the input.
 */
import { describe, expect, it } from "vitest";
import { compileWire } from "../../src/contract/index.js";
import { moneyScaleIssues } from "../../src/server/checking/facts.js";

const screen = (body: string): string =>
  `<App name="Money"><Query id="accounts" tool="listAccounts"/><Query id="spending" tool="listSpending"/>${body}</App>`;

const messages = (body: string): string[] => {
  const result = compileWire(screen(body));
  expect(result.issues).toEqual([]);
  return moneyScaleIssues(result.tree).map((issue) => issue.message);
};

describe("moneyScaleIssues", () => {
  it("blocks a cents total divided by 100 into a money-formatted Stat", () => {
    const [message] = messages('<Stat label="Total" value={sum(spending.data, "amount") / 100} format="money"/>');
    expect(message).toContain("integer CENTS");
    expect(message).toContain('{sum(spending.data, "amount")}');
  });

  it("blocks the division wherever it sits inside the expression", () => {
    expect(messages('<Money cents={(sum(accounts.data, "balance") - 500) / 100}/>')).toHaveLength(1);
    expect(messages('<Stat label="Avg" value={average(accounts.data, "balance") * 0.01} format="money"/>')).toHaveLength(1);
  });

  it('blocks format(…, "currency") on rows, which reads cents as whole dollars', () => {
    const [message] = messages('<DataTable rows={format(accounts.data, "balance", "currency")} columns={[{key:"balance",label:"Balance"}]}/>');
    expect(message).toContain("100x too big");
    expect(message).toContain('format:"money"');
  });

  it("stays silent on the correct spellings", () => {
    expect(messages('<Stat label="Total" value={sum(spending.data, "amount")} format="money"/>')).toEqual([]);
    expect(messages('<Money cents={accounts.data.0.balance}/>')).toEqual([]);
    expect(messages('<DataTable rows={accounts.data} columns={[{key:"balance",format:"money"}]}/>')).toEqual([]);
  });

  it("leaves a division alone where the slot is not money", () => {
    expect(messages('<Stat label="Rate" value={sum(spending.data, "amount") / 100} format="number"/>')).toEqual([]);
    expect(messages('<Num value={sum(spending.data, "amount") / 100}/>')).toEqual([]);
  });
});
