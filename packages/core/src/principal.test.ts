import { describe, expect, it } from "vitest";
import {
  isReservedSubject,
  principalSchema,
  webhookSubject,
} from "./principal.js";

/** 01-core §2 — the only identity shape Vendo speaks. */
describe("principalSchema", () => {
  it("accepts a minimal user principal and one with the optional fields", () => {
    expect(principalSchema.safeParse({ kind: "user", subject: "user_ada" }).success).toBe(true);
    expect(
      principalSchema.parse({ kind: "user", subject: "user_ada", display: "Ada", ephemeral: true }),
    ).toMatchObject({ display: "Ada", ephemeral: true });
  });

  it("accepts an org principal (block-actions design §C: kind:'org' is real)", () => {
    expect(principalSchema.safeParse({ kind: "org", subject: "vendo:org:org_1" }).success).toBe(true);
    expect(principalSchema.parse({ kind: "org", subject: "vendo:org:org_1", display: "Acme" }))
      .toMatchObject({ kind: "org", display: "Acme" });
  });

  it("preserves unknown keys (forward-compatible passthrough)", () => {
    expect(principalSchema.parse({ kind: "user", subject: "s", org: "acme" })).toMatchObject({ org: "acme" });
  });

  it("rejects an unknown kind, a missing subject, and a non-boolean ephemeral", () => {
    expect(principalSchema.safeParse({ kind: "service", subject: "s" }).success).toBe(false);
    expect(principalSchema.safeParse({ kind: "user" }).success).toBe(false);
    expect(principalSchema.safeParse({ kind: "user", subject: "s", ephemeral: "yes" }).success).toBe(false);
  });
});

/** Block-actions design §C — the reserved `vendo:` subject namespace. */
describe("reserved subject namespace", () => {
  it("recognizes reserved subjects by the vendo: prefix", () => {
    expect(isReservedSubject("vendo:webhook:stripe")).toBe(true);
    expect(isReservedSubject("vendo:org:org_1")).toBe(true);
    expect(isReservedSubject("user_ada")).toBe(false);
    expect(isReservedSubject("webhook:stripe")).toBe(false); // legacy bare form is NOT reserved
  });

  it("mints webhook subjects inside the namespace", () => {
    expect(webhookSubject("stripe")).toBe("vendo:webhook:stripe");
  });
});
