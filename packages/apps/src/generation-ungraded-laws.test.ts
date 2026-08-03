import { VENDO_TREE_FORMAT, type Tree } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { actionFaults, isMutatingRisk } from "./generation/validation/actions.js";
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
