import { describe, expect, it } from "vitest";
import { expandInlineRefs } from "../../../../src/contract/genui/wire/inline-refs.js";
import { compileWire } from "../../../../src/contract/genui/wire/compile.js";

/** The registry decides what is a tool, dotted or not: a `{...}` gap is
 *  JavaScript, where a dotted chain before `(` is overwhelmingly a method on
 *  data, so nothing expands unless the WHOLE chain names a tool the host has. */
const TOOLS = { tools: ["invoices.list"] } as const;

describe("expandInlineRefs", () => {
  it("mints one query for two refs sharing tool + args (dedupe)", () => {
    const wire = `<App name="Overdue"><Stat label="Total" value={invoices.list({status:"overdue"}).totalCents}/><Table rows={invoices.list({status:"overdue"}).data} columns={["client"]}/></App>`;
    const { wire: out, minted } = expandInlineRefs(wire, TOOLS);
    expect(minted).toBe(1);
    expect(out).toContain(`<Query id="invoicesList" tool="invoices.list" input={{status:"overdue"}}/>`);
    expect(out).toContain("value={invoicesList.totalCents}");
    expect(out).toContain("rows={invoicesList.data}");
    // No leftover inline call syntax.
    expect(out).not.toContain("invoices.list(");
  });

  it("mints distinct queries for the same tool with different args", () => {
    const wire = `<App name="X"><Table rows={invoices.list({status:"overdue"}).data} columns={["c"]}/><Table rows={invoices.list({status:"paid"}).data} columns={["c"]}/></App>`;
    const { minted } = expandInlineRefs(wire, TOOLS);
    expect(minted).toBe(2);
  });

  it("leaves island ambient tool calls untouched", () => {
    const wire = `<App name="X"><Island name="Look">export default function Look(){ return tools.clients.search({q:"a"}); }</Island></App>`;
    const { wire: out, minted } = expandInlineRefs(wire);
    expect(minted).toBe(0);
    expect(out).toContain("tools.clients.search({q:\"a\"})");
  });

  it("never mints a query out of a call on a declared query's OWN data", () => {
    // A `{...}` gap is JavaScript, so a chain rooted at a <Query> id is
    // arithmetic over that query's rows. Listed as a known tool on purpose: the
    // root gate is the only thing that may stop it, and without that gate this
    // total minted `<Query tool="spending.data.reduce"/>` — a phantom query.
    const wire = `<App name="X"><Query id="spending" tool="host_spending"/><Stat label="Total" value={spending.data.reduce((t, r) => t + r.cents, 0)}/></App>`;
    const { wire: out, minted } = expandInlineRefs(wire, { tools: ["spending.data.reduce"] });
    expect(minted).toBe(0);
    expect(out).toBe(wire);
  });

  it("never mints a name that collides with an existing <Query id> (Greptile P1)", () => {
    const wire = `<App name="X"><Query id="invoicesList" tool="invoices.list" input={{status:"paid"}}/><Table rows={invoicesList.data} columns={["c"]}/><Stat label="Overdue" value={invoices.list({status:"overdue"}).totalCents}/></App>`;
    const { wire: out, minted } = expandInlineRefs(wire, TOOLS);
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

  it("expands only when the WHOLE chain names a known tool — dotted heads included", () => {
    const single = `<App name="Tx"><Table rows={host_listTransactions({}).data} columns={["m"]}/></App>`;
    expect(expandInlineRefs(single).minted).toBe(0);
    expect(expandInlineRefs(single, { tools: ["host_other"] }).minted).toBe(0);
    const dotted = `<App name="X"><Table rows={invoices.list({status:"paid"}).data} columns={["c"]}/></App>`;
    expect(expandInlineRefs(dotted).minted).toBe(0);
    expect(expandInlineRefs(dotted, { tools: ["invoices.other"] }).minted).toBe(0);
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
    const { wire: out, minted } = expandInlineRefs(wire, TOOLS);
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
    const a = compileWire(inline, { inlineRefs: true, inlineTools: [...TOOLS.tools] });
    const b = compileWire(explicit);
    expect(a.complete).toBe(true);
    expect(a.tree.queries).toEqual(b.tree.queries);
    expect(a.tree.nodes).toEqual(b.tree.nodes);
  });
});
