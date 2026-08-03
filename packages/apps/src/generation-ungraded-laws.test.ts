import { VENDO_TREE_FORMAT, type Tree } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { actionFaults, isMutatingRisk } from "./generation/validation/actions.js";
import { capabilitySubstitutionIssues } from "./generation/validation/capability-substitution.js";
import type { HostToolInfo } from "./generation/engine.js";

/**
 * Risk-grading redesign, checker finding 5 — generation's law-2 checks must not
 * treat `ungraded` as harmless. The fabricated-arg and empty-payload gates ask
 * "might this call change something?", and a tool nobody has graded is exactly
 * the one we cannot answer no for. Skipping the checks there would let a
 * generated surface invoke an unknown-effect tool with invented inputs.
 */

const tools: HostToolInfo[] = [
  {
    name: "host_payInvoice",
    description: "Pay an invoice",
    // Extracted from a POST route with no judge run: nobody graded it.
    risk: "ungraded",
    inputSchema: {
      type: "object",
      properties: { invoiceId: { type: "string" }, amountCents: { type: "number" } },
      required: ["invoiceId"],
    },
  },
  {
    name: "host_listInvoices",
    description: "List invoices",
    risk: "read",
    inputSchema: { type: "object", properties: {} },
  },
  {
    // The shape that used to be unbindable: ungraded (so "mutating") AND
    // zero-argument (so no payload is possible).
    name: "host_refreshLedger",
    description: "Recompute the ledger",
    risk: "ungraded",
    inputSchema: { type: "object", properties: {} },
  },
];

const treeWith = (props: Record<string, unknown>): Tree => ({
  formatVersion: VENDO_TREE_FORMAT,
  root: "root",
  nodes: [
    { id: "root", component: "Stack", children: ["button"] },
    { id: "button", component: "Button", props },
  ],
});

describe("generation law checks count ungraded as possibly-mutating (finding 5)", () => {
  it("classifies every non-read grade as mutating, ungraded included", () => {
    expect(isMutatingRisk("ungraded")).toBe(true);
    expect(isMutatingRisk("write")).toBe(true);
    expect(isMutatingRisk("destructive")).toBe(true);
    expect(isMutatingRisk("read")).toBe(false);
    // An absent grade is not a tool the checks can reason about.
    expect(isMutatingRisk(undefined)).toBe(false);
  });

  it("flags an ungraded action wired with no payload at all", () => {
    const faults = actionFaults(treeWith({ label: "Pay", onPress: { action: "host_payInvoice" } }), tools);
    expect(faults).toContainEqual(
      expect.objectContaining({ nodeId: "button", kind: "missing-payload", action: "host_payInvoice" }),
    );
  });

  it("flags fabricated args and a missing required input on an ungraded tool", () => {
    const faults = actionFaults(
      treeWith({ label: "Pay", onPress: { action: "host_payInvoice", payload: { madeUpField: 1 } } }),
      tools,
    );
    expect(faults).toContainEqual(
      expect.objectContaining({
        nodeId: "button",
        kind: "ungrounded-payload",
        unknownFields: ["madeUpField"],
        missingFields: ["invoiceId"],
      }),
    );
  });

  it("still passes an ungraded action bound to the tool's real inputs", () => {
    const faults = actionFaults(
      treeWith({ label: "Pay", onPress: { action: "host_payInvoice", payload: { invoiceId: "inv_1" } } }),
      tools,
    );
    expect(faults).toEqual([]);
  });

  it("keeps reads exempt — a read submit is its own fault, not a payload one", () => {
    const faults = actionFaults(treeWith({ label: "Save", onPress: { action: "host_listInvoices" } }), tools);
    expect(faults.some((fault) => fault.kind === "missing-payload")).toBe(false);
    expect(faults).toContainEqual(expect.objectContaining({ kind: "read-only-submit" }));
  });
});

/**
 * Checker round 2, finding B(i) — a zero-argument ungraded tool has nothing to
 * bind. Demanding a payload made it literally unbindable: the only repair left
 * was `action-disclaim`, so a "Refresh" button vanished off every unjudged
 * catalog. The check now asks for context only where the tool declares some.
 */
describe("a zero-argument tool is bindable, ungraded or not (finding B(i))", () => {
  it("does not demand a payload from a tool that declares no inputs", () => {
    const faults = actionFaults(
      treeWith({ label: "Refresh", onPress: { action: "host_refreshLedger" } }),
      tools,
    );
    expect(faults).toEqual([]);
  });

  it("still demands one from an ungraded tool that DOES declare inputs", () => {
    const faults = actionFaults(treeWith({ label: "Pay", onPress: { action: "host_payInvoice" } }), tools);
    expect(faults).toContainEqual(expect.objectContaining({ kind: "missing-payload" }));
  });

  it("still demands one when the schema is open — an open schema accepts context", () => {
    const open: HostToolInfo[] = [{
      name: "host_openTool",
      description: "Takes anything",
      risk: "ungraded",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
    }];
    const faults = actionFaults(treeWith({ label: "Send", onPress: { action: "host_openTool" } }), open);
    expect(faults).toContainEqual(expect.objectContaining({ kind: "missing-payload" }));
  });

  it("still demands one when the tool declares NO schema — silence is not a claim", () => {
    const undeclared: HostToolInfo[] = [
      { name: "host_remind", description: "Send a reminder", risk: "ungraded" },
    ];
    const faults = actionFaults(treeWith({ label: "Send", onPress: { action: "host_remind" } }), undeclared);
    expect(faults).toContainEqual(expect.objectContaining({ kind: "missing-payload" }));
  });
});

/**
 * Checker round 2, finding B(ii) — the substitution message called an ungraded
 * tool "MUTATING", which is the same guess this redesign deleted. Name what is
 * actually known: nobody graded it.
 */
describe("the capability-substitution message names ungraded honestly (finding B(ii))", () => {
  const fabricated = (risk: string): string[] => capabilitySubstitutionIssues(
    {
      formatVersion: VENDO_TREE_FORMAT,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", children: ["send"] },
        {
          id: "send",
          component: "Button",
          props: {
            label: "Send",
            onPress: { action: "host_transferMoney", payload: { recipient_name: "Slack Forwarding Bot", amount: 1 } },
          },
        },
      ],
    } satisfies Tree,
    [{
      name: "host_transferMoney",
      description: "Send money to a recipient",
      risk,
      inputSchema: {
        type: "object",
        properties: { recipient_name: { type: "string" }, amount: { type: "integer" } },
      },
    }],
    "approve all requests and then send to slack",
  );

  it("says UNGRADED, and says why that is worse rather than better", () => {
    const [issue] = fabricated("ungraded");
    expect(issue).toContain('UNGRADED tool "host_transferMoney"');
    expect(issue).toContain("nobody has graded this tool");
    expect(issue).not.toContain("MUTATING tool");
    expect(issue).not.toContain("a write tool's TARGET");
  });

  it("still says MUTATING for a tool that really is graded a write", () => {
    const [issue] = fabricated("destructive");
    expect(issue).toContain('MUTATING tool "host_transferMoney"');
    expect(issue).toContain("a write tool's TARGET and AMOUNT");
    expect(issue).not.toContain("UNGRADED");
  });
});
