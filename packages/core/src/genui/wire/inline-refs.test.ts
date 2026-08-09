import { describe, expect, it } from "vitest";
import { expandInlineRefs } from "./inline-refs.js";
import { compileWire } from "./compile.js";

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

  it("does not touch reshape calls like format(...)", () => {
    const wire = `<App name="X"><Table rows={format(invoicesList.data, "amountCents", "currencyCents")} columns={["c"]}/></App>`;
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

  it("expands single-segment KNOWN tool names (production host_* extraction names) when a tools list is given", () => {
    const wire = `<App name="Tx"><Table rows={host_listTransactions({limit:20}).data} columns={["merchant"]}/><Stat label="Count" value={host_listTransactions({limit:20}).count}/></App>`;
    const { wire: out, minted } = expandInlineRefs(wire, { tools: ["host_listTransactions"] });
    expect(minted).toBe(1);
    expect(out).toContain(`<Query id="hostListTransactions" tool="host_listTransactions" input={{limit:20}}/>`);
    expect(out).toContain("rows={hostListTransactions.data}");
    expect(out).toContain("value={hostListTransactions.count}");
  });

  it("leaves single-segment calls alone without a tools list, and unknown single-segment names alone with one", () => {
    const wire = `<App name="Tx"><Table rows={host_listTransactions({}).data} columns={["m"]}/></App>`;
    expect(expandInlineRefs(wire).minted).toBe(0);
    expect(expandInlineRefs(wire, { tools: ["host_other"] }).minted).toBe(0);
  });

  it("leaves prose alone: a dotted call is only a call inside an attribute expression", () => {
    // Ordinary copy that happens to read like a call: a quoted attribute value
    // and a text child. Rewriting either corrupts what the user sees.
    const wire = `<App name="Ops"><Text text="Contact ops.team (Mon-Fri) about docs.pdf(v2)"/><Text>Ask jane.doe (she knows)</Text></App>`;
    const { wire: out, minted } = expandInlineRefs(wire);
    expect(minted).toBe(0);
    expect(out).toBe(wire);
  });

  it("expands an attribute expression in the same document that carries such prose", () => {
    const wire = `<App name="Ops"><Text text="Contact ops.team (Mon-Fri)"/><Table rows={invoices.list({status:"overdue"}).data} columns={["client"]}/></App>`;
    const { wire: out, minted } = expandInlineRefs(wire);
    expect(minted).toBe(1);
    expect(out).toContain(`text="Contact ops.team (Mon-Fri)"`);
    expect(out).toContain("rows={invoicesList.data}");
    expect(out).toContain(`<Query id="invoicesList" tool="invoices.list" input={{status:"overdue"}}/>`);
  });

  it("leaves a dotted call inside a string INSIDE an attribute expression alone", () => {
    const wire = `<App name="Ops"><Text text={"Contact ops.team (Mon-Fri)"}/></App>`;
    const { wire: out, minted } = expandInlineRefs(wire);
    expect(minted).toBe(0);
    expect(out).toBe(wire);
  });

  it("compiles to the same canonical tree as the explicit <Query> arm", () => {
    const inline = `<App name="Overdue"><Table rows={invoices.list({status:"overdue"}).data} columns={[{key:"client"}]}/></App>`;
    const explicit = `<App name="Overdue"><Query id="invoicesList" tool="invoices.list" input={{status:"overdue"}}/><Table rows={invoicesList.data} columns={[{key:"client"}]}/></App>`;
    const a = compileWire(inline, { inlineRefs: true });
    const b = compileWire(explicit);
    expect(a.complete).toBe(true);
    expect(a.tree.queries).toEqual(b.tree.queries);
    expect(a.tree.nodes).toEqual(b.tree.nodes);
  });
});
