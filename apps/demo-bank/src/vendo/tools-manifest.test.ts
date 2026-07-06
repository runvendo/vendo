/**
 * `.vendo/tools.json` is the reviewable manifest the @vendoai/next handler
 * loads at runtime — these tests pin the demo's format annotations (money is
 * integer CENTS everywhere in the bank API) so the render_view prompt always
 * carries the divide-by-100 rule for money-bearing tools.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toolsManifestSchema } from "@vendoai/core";

const manifest = toolsManifestSchema.parse(
  JSON.parse(readFileSync(join(__dirname, "..", "..", ".vendo", "tools.json"), "utf8")),
);

const byName = (name: string) => {
  const tool = manifest.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing manifest tool ${name}`);
  return tool;
};

describe("demo-bank tools.json format annotations", () => {
  it("still validates against the frozen tools-manifest schema", () => {
    expect(manifest.version).toBe(1);
  });

  it("annotates transaction amounts as cents on every transaction-returning tool", () => {
    for (const name of [
      "list_transactions",
      "get_transaction",
      "get_account_transactions",
      "get_card_transactions",
    ]) {
      expect(byName(name).formats, name).toMatchObject({ amount: "cents" });
    }
  });

  it("annotates the remaining money fields as cents", () => {
    expect(byName("list_accounts").formats).toMatchObject({ balance: "cents" });
    expect(byName("get_account").formats).toMatchObject({ balance: "cents" });
    expect(byName("get_budgets").formats).toMatchObject({ limit: "cents", spent: "cents" });
    expect(byName("list_goals").formats).toMatchObject({ target: "cents", saved: "cents" });
    expect(byName("get_cashflow").formats).toMatchObject({ in: "cents", out: "cents" });
    expect(byName("get_recurring").formats).toMatchObject({ amount: "cents" });
    expect(byName("get_spending_by_category").formats).toMatchObject({ amount: "cents" });
    expect(byName("list_scheduled_payments").formats).toMatchObject({ amount: "cents" });
    expect(byName("get_profile").formats).toMatchObject({ netWorth: "cents" });
  });
});
