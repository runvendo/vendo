/**
 * An action gets the same two facts a query always got: the name is real, and
 * the call can be made. The live failure this closes shipped repeatedly —
 * `<Form onSubmit="cancel_transfer">` wrapped around a `<Select>`, which calls
 * the tool with no `id` because a Form's fields are not its submit's arguments
 * (`@vendoai/ui` kit/forms/form.tsx) — and painted as a button that does
 * nothing when pressed.
 */
import { compileWire } from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { actionWiringIssues } from "../../src/server/checking/facts.js";
import type { HostToolInfo } from "../../src/server/checking/deps.js";

const tools: HostToolInfo[] = [
  { name: "list_transfers", description: "Pending transfers", risk: "read", inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
  {
    name: "cancel_transfer",
    description: "Cancel one transfer",
    risk: "write",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

const treeOf = (wire: string) => compileWire(wire).tree;

const issues = (wire: string) => actionWiringIssues(treeOf(wire), tools);

describe("an action must name a real tool and be able to supply its arguments", () => {
  it("blocks a submit that names a tool needing an id it never carries", () => {
    const found = issues('<App name="Cancel"><Query id="transfers" tool="list_transfers"/><Form onSubmit="cancel_transfer" submitLabel="Cancel transfer"><Select label="Transfer" options={transfers.data} labelField="to" valueField="id"/></Form></App>');

    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('wires "cancel_transfer", which requires "id"');
    expect(found[0]?.message).toContain("<Island>");
  });

  it("blocks an action naming a tool the host does not have, listing the ones it does", () => {
    const found = issues('<App name="Cancel"><Button label="Cancel" onClick="cancel_transfers"/></App>');

    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('wires unknown tool "cancel_transfers"');
    expect(found[0]?.message).toContain("cancel_transfer");
  });

  it("says nothing about an argument-free tool, an fn: handler, or a payload that supplies the argument", () => {
    expect(issues('<App name="Refresh"><Button label="Refresh" onClick="list_transfers"/></App>')).toEqual([]);
    expect(issues('<App name="Own code"><Button label="Open" onClick="fn:open_detail"/></App>')).toEqual([]);
    expect(issues('<App name="Cancel"><Query id="transfers" tool="list_transfers"/><Button label="Cancel" onClick={{ action: "cancel_transfer", payload: { id: transfers.data.0.id } }}/></App>')).toEqual([]);
  });

  it("stays silent with no declared host surface to measure against", () => {
    expect(actionWiringIssues(treeOf('<App name="Cancel"><Form onSubmit="cancel_transfer"/></App>'), undefined)).toEqual([]);
  });
});
