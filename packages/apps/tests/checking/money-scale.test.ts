/**
 * ONE money conversion (`facts.ts`'s `money-scale`).
 *
 * The screen this exists for showed a "$362.65" net-worth headline above rows
 * reading "$941,220.00" — one 100x too small and one 100x too large, on the same
 * three accounts holding $9,412.20, $28,141.35 and -$1,288.40. Both came from a
 * SECOND conversion: the headline divided cents by 100 and then asked for
 * `format="money"`, which divides again, and the rows went through the reshape
 * `currency` kind, which reads its input as whole dollars.
 *
 * Through the real seam in both halves — the wire compiler produces the tree and
 * the shipped checking layer reads it — because a check that only ever sees a
 * hand-built tree cannot disagree with the compiler.
 */
import { VENDO_APP_FORMAT, type ShapeType } from "@vendoai/core";
import { compileWire, type AppDocument, type NormalizedCatalog } from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createCheckingLayer } from "../../src/server/checking/layer.js";
import type { FloorDependencies, HostToolInfo } from "../../src/server/checking/deps.js";

const tools: HostToolInfo[] = [{
  name: "list_accounts",
  description: "Every account the customer holds; `balance` is a whole number of CENTS",
  risk: "read",
  inputSchema: { type: "object", properties: {} },
}];

const toolShapes: Record<string, ShapeType> = {
  list_accounts: {
    kind: "object",
    fields: {
      data: {
        kind: "array",
        items: { kind: "object", fields: { name: { kind: "string" }, balance: { kind: "number" } } },
      },
    },
  },
};

const catalog: NormalizedCatalog = [];

const deps = (): FloorDependencies => ({ catalog, tools, toolShapes });

const app = (body: string): AppDocument => {
  const wire = `<App name="Accounts"><Query id="accounts" tool="list_accounts"/>${body}</App>`;
  const compiled = compileWire(wire, { toolShapes });
  expect(compiled.issues).toEqual([]);
  return {
    format: VENDO_APP_FORMAT,
    id: "app_money_scale",
    name: compiled.name ?? "Untitled",
    ui: "tree",
    tree: compiled.tree as unknown as AppDocument["tree"],
  } as AppDocument;
};

const check = async (body: string): Promise<string[]> => {
  const findings = await createCheckingLayer({ deps: deps() }).run({
    document: app(body),
    request: "show me all my accounts and what I'm worth in total",
  });
  return findings
    .filter((finding) => finding.check === "money-scale")
    .map((finding) => `${finding.severity} ${finding.message}`);
};

describe("a money slot is the only place money is scaled", () => {
  it("blocks a money expression that divides by 100, because format=\"money\" already did", async () => {
    const findings = await check('<Stat label="Total net worth" value={sum(accounts.data, "balance") / 100} format="money"/>');

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("block");
    expect(findings[0]).toContain("divides by 100 a second time");
  });

  it("blocks the same double conversion on <Money cents/>, whose slot is money by name", async () => {
    expect(await check('<Money cents={sum(accounts.data, "balance") / 100}/>')).toHaveLength(1);
  });

  it('blocks the "currency" reshape, which renders integer cents 100x too large', async () => {
    const findings = await check('<DataTable rows={format(accounts.data, "balance", "currency")} columns={[{key:"name",label:"Account"},{key:"balance",label:"Balance",align:"end"}]}/>');

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("whole DOLLARS");
    expect(findings[0]).toContain('format:"money"');
  });

  it("passes the screen that converts once — raw cents into the Kit's own money tokens", async () => {
    expect(await check([
      '<Stat label="Total net worth" value={sum(accounts.data, "balance")} format="money"/>',
      '<DataTable rows={accounts.data} columns={[{key:"name",label:"Account"},{key:"balance",label:"Balance",format:"money",align:"end"}]}/>',
    ].join(""))).toEqual([]);
  });

  it("leaves arithmetic alone outside a money slot — /100 is only wrong where money is formatted", async () => {
    expect(await check('<Stat label="Accounts per hundred" value={count(accounts.data) / 100}/>')).toEqual([]);
    expect(await check('<Stat label="Share" value={count(accounts.data) / 100} format="percent"/>')).toEqual([]);
  });
});
