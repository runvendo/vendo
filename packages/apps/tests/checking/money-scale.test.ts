/**
 * A money slot converts to major units itself, so a computed value that already
 * divided by 100 is converted twice — the screen prints a hundredth of the
 * amount the tool returned.
 *
 * Live 2026-08-10, genbench `spend-dashboard` (vendo-sonnet): the assembled
 * document's three headline stats all read `{… / 100}` into `format="money"`,
 * and the screen printed $42.43, $28.50 and $362.65 for 424311, 285000 and
 * 3626515 cents. Every mechanical check passed. The wire in `DASHBOARD` below is
 * that document's headline strip, verbatim.
 *
 * It runs through the REAL compile and the REAL checking layer — the two halves
 * that have to agree for the agent to be told anything at all.
 */
import { VENDO_APP_FORMAT, type ShapeType } from "@vendoai/core";
import {
  compileWire,
  type AppDocument,
  type NormalizedCatalog,
} from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import type { FloorDependencies, HostToolInfo } from "../../src/server/checking/deps.js";
import { createCheckingLayer } from "../../src/server/checking/layer.js";

const rows = (fields: Record<string, ShapeType>): ShapeType => ({
  kind: "object",
  fields: { data: { kind: "array", items: { kind: "object", fields } } },
});

const toolShapes: Record<string, ShapeType> = {
  get_spending: rows({ category: { kind: "string" }, amount: { kind: "number" } }),
  list_accounts: rows({ name: { kind: "string" }, balance: { kind: "number" } }),
};

const tools: HostToolInfo[] = Object.keys(toolShapes).map((name) => ({
  name,
  description: "maple",
  risk: "read",
  inputSchema: { type: "object", properties: {} },
}));

const catalog: NormalizedCatalog = [];

const deps: FloorDependencies = { catalog, tools, toolShapes };

const documentFrom = (wire: string): AppDocument => {
  const compiled = compileWire(wire, { toolShapes });
  return {
    format: VENDO_APP_FORMAT,
    id: "app_money_scale",
    name: compiled.name ?? "Untitled",
    ui: "tree",
    tree: compiled.tree as unknown as AppDocument["tree"],
  } as AppDocument;
};

const findingsFor = async (wire: string): Promise<string[]> => {
  const found = await createCheckingLayer({ deps }).run({
    document: documentFrom(wire),
    request: "build me a spending dashboard",
  });
  return found.map((finding) => `${finding.severity} ${finding.where ?? ""} ${finding.message}`);
};

const money = (findings: readonly string[]): string[] =>
  findings.filter((finding) => finding.includes("money slot"));

const app = (body: string): string =>
  `<App name="Spending"><Query id="spending" tool="get_spending"/><Query id="accounts" tool="list_accounts"/>${body}</App>`;

/** The headline strip of the screen that shipped $42.43 for $4,243.11. */
const DASHBOARD = app(
  '<Grid columns={3}>'
  + '<Stat label="Total spent this month" value={sum(spending.data, "amount") / 100} format="money"/>'
  + '<Stat label="Largest category spend" value={max(spending.data, "amount") / 100} format="money"/>'
  + '<Stat label="Total balance across accounts" value={sum(accounts.data, "balance") / 100} format="money"/>'
  + '</Grid>',
);

describe("a money slot is fed cents, and the floor says so", () => {
  it("blocks every headline the live dashboard scaled down, naming the fix", async () => {
    const findings = money(await findingsFor(DASHBOARD));

    expect(findings).toHaveLength(3);
    for (const finding of findings) {
      expect(finding).toContain("block");
      expect(finding).toContain("INTEGER CENTS");
    }
  });

  it("catches the same conversion written as a multiply, and inside a Money slot", async () => {
    expect(money(await findingsFor(app('<Money cents={sum(spending.data, "amount") / 100}/>')))).toHaveLength(1);
    expect(money(await findingsFor(app('<Stat label="Spent" value={sum(spending.data, "amount") * 0.01} format="money"/>')))).toHaveLength(1);
  });

  it("says nothing about the honest document — cents into the slot, and nothing else changed", async () => {
    const honest = app(
      '<Grid columns={3}>'
      + '<Stat label="Total spent this month" value={sum(spending.data, "amount")} format="money"/>'
      + '<Stat label="Largest category spend" value={max(spending.data, "amount")} format="money"/>'
      + '<Stat label="Total balance across accounts" value={sum(accounts.data, "balance")} format="money"/>'
      + '</Grid>',
    );

    expect(await findingsFor(honest)).toEqual([]);
  });

  it("leaves a /100 alone where nothing divides again: a ratio, and a plain number", async () => {
    const ratio = app('<Percent value={sum(spending.data, "amount") / 100}/>');
    const plain = app('<Stat label="Spent" value={sum(spending.data, "amount") / 100} format="number"/>');

    expect(await findingsFor(ratio)).toEqual([]);
    expect(await findingsFor(plain)).toEqual([]);
  });
});
