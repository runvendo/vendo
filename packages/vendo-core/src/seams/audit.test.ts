import { describe, expect, it } from "vitest";
import type { AuditEvent } from "./store";

describe("audit contract", () => {
  it("admits the ENG-193 kinds", () => {
    const scope = { tenantId: "t", subject: "u" };
    const events: AuditEvent[] = [
      { at: "now", principal: scope, kind: "grant_created", grantId: "g1", tool: "send_email", scopePreview: "to *@acme.co" },
      { at: "now", principal: scope, kind: "grant_revoked", grantId: "g1", tool: "send_email" },
      { at: "now", principal: scope, kind: "judge_escalation", toolName: "send_email", reason: "tainted source" },
      { at: "now", principal: scope, kind: "consent", consentId: "c1", decision: "yes" },
    ];
    expect(events).toHaveLength(4);
  });
});
