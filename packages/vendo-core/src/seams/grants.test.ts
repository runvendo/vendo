import { describe, expect, it } from "vitest";
import { grantScopeSchema, permissionGrantSchema } from "./grants";

describe("grant contract", () => {
  it("accepts a constrained scope grant", () => {
    const grant = permissionGrantSchema.parse({
      id: "g-1",
      tenantId: "t1",
      subject: "u1",
      tool: "send_email",
      descriptorHash: "abc123",
      scope: {
        kind: "constrained",
        constraints: [{ path: "to", op: "matches", value: "*@acme.co" }],
      },
      duration: "standing",
      source: { kind: "fade" },
      grantedAt: "2026-07-04T00:00:00Z",
    });
    expect(grant.scope.kind).toBe("constrained");
  });

  it("rejects an unknown scope kind", () => {
    expect(() =>
      grantScopeSchema.parse({ kind: "everything" }),
    ).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      permissionGrantSchema.parse({
        id: "g-1", tenantId: "t1", subject: "u1", tool: "t",
        descriptorHash: "h", scope: { kind: "tool" }, duration: "standing",
        source: { kind: "chat" }, grantedAt: "now", surprise: true,
      }),
    ).toThrow();
  });
});
