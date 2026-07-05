import { describe, it, expect } from "vitest";
import { brandTokensSchema } from "@vendoai/components";
import { mapleBrand } from "./brand";

describe("mapleBrand", () => {
  it("validates against the BrandTokens schema", () => {
    expect(() => brandTokensSchema.parse(mapleBrand)).not.toThrow();
  });

  it("fontFamily is a concrete stack — no var() references (they cannot resolve inside the sandbox iframe)", () => {
    // A var() inside the token invalidates the whole font-family declaration
    // at computed-value time in the sandbox (where host vars don't exist),
    // falling back to the UA serif default. Audit F6.
    expect(mapleBrand.fontFamily).not.toContain("var(");
  });
});
