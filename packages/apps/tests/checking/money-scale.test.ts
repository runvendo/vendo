/**
 * A money slot takes integer CENTS and divides by 100 itself, so a computed
 * total that divides by 100 first prints one hundredth of the amount. The
 * writer produced `sum(accounts.data, "balance") / 100` on eleven of
 * thirty-five benchmark screens — a $36,265.00 net worth rendered as $362.65
 * beside a table that showed the same cents correctly — so the shape is
 * refused on the create path the save tool actually calls, not left to the
 * reviewer to re-derive.
 */
import { describe, expect, it } from "vitest";
import { compileWire, type NormalizedCatalog } from "../../src/contract/index.js";
import { scriptedLanguageModel } from "../../src/server/testing/scripted-model.js";
import { validateCompiledCreate } from "../../src/server/generation/validation/validate.js";
import type { GenerationDependencies, HostToolInfo } from "../../src/server/generation/engine.js";

const catalog: NormalizedCatalog = [];
const tools: HostToolInfo[] = [
  { name: "list_accounts", description: "every account, `balance` in integer cents", risk: "read" },
];

const deps = (): GenerationDependencies => ({
  model: scriptedLanguageModel(() => '<App name="unused"/>'),
  catalog,
  tools,
});

const app = (value: string): string =>
  `<App name="Accounts"><Query id="accounts" tool="list_accounts"/><Stack><Stat label="Total" value={${value}} format="money"/></Stack></App>`;

describe("money slots take cents", () => {
  it("refuses a computed money value that divides by 100 before the component formats it", async () => {
    const { document, issues } = await validateCompiledCreate(compileWire(app('sum(accounts.data, "balance") / 100')), deps());

    expect(document).toBeUndefined();
    const issue = issues.find((line) => line.includes('prop "value"'));
    expect(issue).toContain('sum(accounts.data, "balance") / 100');
    expect(issue).toContain("integer CENTS");
  });

  it("passes the same total left in cents", async () => {
    const { document, issues } = await validateCompiledCreate(compileWire(app('sum(accounts.data, "balance")')), deps());

    expect(issues).toEqual([]);
    expect(document).toBeDefined();
  });

  it("leaves a division by 100 alone where no money slot reads it", async () => {
    const wire = '<App name="Accounts"><Query id="accounts" tool="list_accounts"/><Stack><Stat label="Share" value={sum(accounts.data, "balance") / 100} format="percent"/></Stack></App>';
    const { issues } = await validateCompiledCreate(compileWire(wire), deps());

    expect(issues).toEqual([]);
  });
});
