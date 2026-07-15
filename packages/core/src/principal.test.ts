import { describe, expect, it } from "vitest";
import { principalSchema } from "./principal.js";

/** 01-core §2 — the only identity shape Vendo speaks. */
describe("principalSchema", () => {
  it("accepts a minimal user principal and one with the optional fields", () => {
    expect(principalSchema.safeParse({ kind: "user", subject: "user_ada" }).success).toBe(true);
    expect(
      principalSchema.parse({ kind: "user", subject: "user_ada", display: "Ada", ephemeral: true }),
    ).toMatchObject({ display: "Ada", ephemeral: true });
  });

  it("preserves unknown keys (forward-compatible passthrough)", () => {
    expect(principalSchema.parse({ kind: "user", subject: "s", org: "acme" })).toMatchObject({ org: "acme" });
  });

  it("rejects a non-user kind, a missing subject, and a non-boolean ephemeral", () => {
    expect(principalSchema.safeParse({ kind: "service", subject: "s" }).success).toBe(false);
    expect(principalSchema.safeParse({ kind: "user" }).success).toBe(false);
    expect(principalSchema.safeParse({ kind: "user", subject: "s", ephemeral: "yes" }).success).toBe(false);
  });
});
