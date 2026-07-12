import {
  appDocumentSchema,
  approvalRequestSchema,
  auditEventSchema,
  permissionGrantSchema,
  type AppDocument,
  type ApprovalRequest,
  type AuditEvent,
  type PermissionGrant,
  type Principal,
} from "@vendoai/core";

export const persistentPrincipal: Principal = { kind: "user", subject: "user_test" };

export const at = (second: number): string => `2026-01-02T03:04:${String(second).padStart(2, "0")}.000Z`;

export function appFixture(id = "app_test", name = "Test app"): AppDocument {
  return appDocumentSchema.parse({ format: "vendo/app@1", id, name });
}

export function grantFixture(
  id = "grt_test",
  overrides: Partial<PermissionGrant> = {},
): PermissionGrant {
  return permissionGrantSchema.parse({
    id,
    subject: "user_test",
    tool: "host_invoices_list",
    descriptorHash: "sha256:test",
    scope: { kind: "tool" },
    duration: "standing",
    appId: "app_test",
    source: "chat",
    grantedAt: at(10),
    ...overrides,
  });
}

export function approvalFixture(
  id = "apr_test",
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return approvalRequestSchema.parse({
    id,
    call: { id: `call_${id}`, tool: "host_invoices_pay", args: { invoiceId: "inv_1" } },
    descriptor: {
      name: "host_invoices_pay",
      description: "Pay an invoice",
      inputSchema: { type: "object" },
      risk: "write",
    },
    inputPreview: "Pay invoice inv_1",
    ctx: { principal: persistentPrincipal, venue: "chat", presence: "present", appId: "app_test" },
    createdAt: at(20),
    ...overrides,
  });
}

export function auditFixture(
  id = "aud_test",
  overrides: Partial<AuditEvent> = {},
): AuditEvent {
  return auditEventSchema.parse({
    id,
    at: at(30),
    kind: "tool-call",
    principal: persistentPrincipal,
    venue: "chat",
    presence: "present",
    appId: "app_test",
    tool: "host_invoices_list",
    outcome: "ok",
    detail: { count: 1 },
    ...overrides,
  });
}
