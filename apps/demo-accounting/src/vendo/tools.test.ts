/**
 * The in-process read tools must CARRY their read-only annotation, not just
 * be name-allowlisted by the policy (policy.ts's ALWAYS_ALLOW). The audit
 * trail classifies every execution from the DESCRIPTOR
 * (`mutating: readOnlyHint !== true` in @vendoai/runtime's auditPolicy), so
 * an unannotated read tool lands in the Trust screen's diary as a mutating
 * "action you approved" — the browser-observed "0 reads, 4 actions you
 * approved" miscount after nothing but read-only runs.
 */
import { describe, expect, it } from "vitest";
import { buildDescriptor, auditPolicy, type VendoPrincipal } from "@vendoai/runtime";
import type { AuditEvent, AuditLog, Principal } from "@vendoai/core";
import { demoTools, READ_ONLY_TOOLS } from "./tools";

const PRINCIPAL: VendoPrincipal = { userId: "test" };
const SCOPE: Principal = { tenantId: "t", subject: "test" };

describe("in-process read tools", () => {
  it("every READ_ONLY_TOOLS tool object carries readOnlyHint (the audit classifier's input)", () => {
    const tools = demoTools();
    for (const name of READ_ONLY_TOOLS) {
      const descriptor = buildDescriptor(name, tools[name], "engine");
      expect(descriptor.annotations.readOnlyHint, `${name} must be read-annotated`).toBe(true);
      expect(descriptor.annotations.destructiveHint ?? false, name).toBe(false);
    }
  });

  it("an executed read tool audits as a READ (mutating:false), so the diary counts it as one", async () => {
    const events: AuditEvent[] = [];
    const audit: AuditLog = {
      append: async (e) => {
        events.push(e);
      },
      query: async () => events,
    };
    const policy = auditPolicy(audit, { principalScope: () => SCOPE });
    const descriptor = buildDescriptor("get_clients", demoTools()["get_clients"], "engine");
    await policy.onExecuted?.(
      { toolName: "get_clients", input: {}, descriptor, principal: PRINCIPAL, toolCallId: "c1" },
      "allow",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "tool_execution", mutating: false, dangerous: false });
  });
});
