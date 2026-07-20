import { describe, expect, it } from "vitest";
import { expandInlineRefs } from "./inline-refs.js";
import { compileWireV2 } from "./compile.js";

describe("expandInlineRefs", () => {
  it("mints one query for two refs sharing tool + args (dedupe)", () => {
    const wire = `<App name="Overdue"><Stat label="Total" value={invoices.list({status:"overdue"}).totalCents}/><Table rows={invoices.list({status:"overdue"}).data} columns={["client"]}/></App>`;
    const { wire: out, minted } = expandInlineRefs(wire);
    expect(minted).toBe(1);
    expect(out).toContain(`<Query id="invoicesList" tool="invoices.list" input={{status:"overdue"}}/>`);
    expect(out).toContain("value={invoicesList.totalCents}");
    expect(out).toContain("rows={invoicesList.data}");
    // No leftover inline call syntax.
    expect(out).not.toContain("invoices.list(");
  });

  it("mints distinct queries for the same tool with different args", () => {
    const wire = `<App name="X"><Table rows={invoices.list({status:"overdue"}).data} columns={["c"]}/><Table rows={invoices.list({status:"paid"}).data} columns={["c"]}/></App>`;
    const { minted } = expandInlineRefs(wire);
    expect(minted).toBe(2);
  });

  it("leaves island ambient tool calls untouched", () => {
    const wire = `<App name="X"><Island name="Look">export default function Look(){ return tools.clients.search({q:"a"}); }</Island></App>`;
    const { wire: out, minted } = expandInlineRefs(wire);
    expect(minted).toBe(0);
    expect(out).toContain("tools.clients.search({q:\"a\"})");
  });

  it("does not touch reshape pipes like format(...)", () => {
    const wire = `<App name="X"><Table rows={invoicesList.data | format(amountCents, currencyCents)} columns={["c"]}/></App>`;
    const { minted } = expandInlineRefs(wire);
    expect(minted).toBe(0);
  });

  it("never mints a name that collides with an existing <Query id> (Greptile P1)", () => {
    const wire = `<App name="X"><Query id="invoicesList" tool="invoices.list" input={{status:"paid"}}/><Table rows={invoicesList.data} columns={["c"]}/><Stat label="Overdue" value={invoices.list({status:"overdue"}).totalCents}/></App>`;
    const { wire: out, minted } = expandInlineRefs(wire);
    expect(minted).toBe(1);
    // The minted query must NOT reuse the existing "invoicesList" id.
    expect(out).toContain(`<Query id="invoicesList2" tool="invoices.list" input={{status:"overdue"}}/>`);
    expect(out).toContain("value={invoicesList2.totalCents}");
    // The pre-existing declaration and its binding are untouched.
    expect(out).toContain(`<Query id="invoicesList" tool="invoices.list" input={{status:"paid"}}/>`);
    expect(out).toContain("rows={invoicesList.data}");
  });

  it("compiles to the same canonical tree as the explicit <Query> arm", () => {
    const inline = `<App name="Overdue"><Table rows={invoices.list({status:"overdue"}).data} columns={[{key:"client"}]}/></App>`;
    const explicit = `<App name="Overdue"><Query id="invoicesList" tool="invoices.list" input={{status:"overdue"}}/><Table rows={invoicesList.data} columns={[{key:"client"}]}/></App>`;
    const a = compileWireV2(inline, { inlineRefs: true });
    const b = compileWireV2(explicit);
    expect(a.complete).toBe(true);
    expect(a.tree.queries).toEqual(b.tree.queries);
    expect(a.tree.nodes).toEqual(b.tree.nodes);
  });
});
