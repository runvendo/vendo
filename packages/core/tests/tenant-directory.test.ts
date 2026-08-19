import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAP_SCOPE,
  tenantCapSchema,
  tenantDirectoryPayloadSchema,
  tenantLimitsSchema,
} from "../src/tenant-directory.js";

/** The seam BOTH repos parse. A cap that carried a bare number would let the
    SDK and the console disagree about whose usage it covers, so the scope is
    stored and never implied. */
describe("tenant directory payload", () => {
  it("parses memberships and per-tenant limits together", () => {
    const parsed = tenantDirectoryPayloadSchema.parse({
      memberships: [{ org: "acme", display: "Acme Corp" }],
      limits: {
        acme: {
          messagesPerDay: { limit: 50, scope: "per-member" },
          generationsPerMonth: { limit: 1000, scope: "per-tenant" },
        },
      },
    });
    expect(parsed.memberships[0]?.org).toBe("acme");
    expect(parsed.limits["acme"]?.generationsPerMonth).toEqual({ limit: 1000, scope: "per-tenant" });
  });

  it("reads an unknown user as empty, never as a failure", () => {
    expect(tenantDirectoryPayloadSchema.parse({ memberships: [], limits: {} }))
      .toEqual({ memberships: [], limits: {} });
  });

  it("refuses a cap with no scope, so no reader gets to assume one", () => {
    expect(() => tenantCapSchema.parse({ limit: 50 })).toThrow();
    expect(() => tenantCapSchema.parse(50)).toThrow();
    expect(() => tenantCapSchema.parse({ limit: 50, scope: "per-org" })).toThrow();
  });

  it("refuses a limit that is not a positive integer", () => {
    for (const limit of [0, -1, 1.5]) {
      expect(() => tenantCapSchema.parse({ limit, scope: "per-member" })).toThrow();
    }
  });

  it("names a default scope per cap, applied by the console at write time", () => {
    expect(DEFAULT_CAP_SCOPE).toEqual({
      messagesPerDay: "per-member",
      generationsPerMonth: "per-tenant",
    });
  });

  it("passes unknown keys through, so a newer console never breaks an older SDK", () => {
    const parsed = tenantLimitsSchema.parse({
      messagesPerDay: { limit: 5, scope: "per-member", note: "hi" },
      seatsPerTenant: { limit: 3, scope: "per-tenant" },
    });
    expect(parsed).toMatchObject({ seatsPerTenant: { limit: 3 } });
  });
});
