import { describe, expect, it } from "vitest";
import { isVendoError, VendoError } from "../src/index.js";

describe("VendoError", () => {
  it("preserves code, detail, name, message, and Error identity", () => {
    const error = new VendoError("blocked", "No access", { policy: "deny" });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(VendoError);
    expect(error.name).toBe("VendoError");
    expect(error.message).toBe("No access");
    expect(error.code).toBe("blocked");
    expect(error.detail).toEqual({ policy: "deny" });
  });
});

describe("isVendoError", () => {
  it("recognizes one this realm minted", () => {
    expect(isVendoError(new VendoError("blocked", "No access"))).toBe(true);
  });

  /** A host bundle carrying a second copy of this package (dist/ beside
   *  dist/cjs/) mints VendoErrors of a DIFFERENT class. 0.27.0's hosted-store
   *  refusal arrived that way, failed every `instanceof`, and 501'd every route
   *  as an unknown fault. */
  it("recognizes one another realm's copy minted", () => {
    const crossRealm = Object.assign(new Error("collection not enabled"), {
      name: "VendoError",
      code: "blocked",
    });
    expect(isVendoError(crossRealm)).toBe(true);
    expect(crossRealm instanceof VendoError).toBe(false);
  });

  it("says no to anything that only looks the part", () => {
    expect(isVendoError(new Error("plain"))).toBe(false);
    expect(isVendoError(Object.assign(new Error("no code"), { name: "VendoError" }))).toBe(false);
    expect(isVendoError({ name: "VendoError", code: "blocked", message: "not an Error" })).toBe(false);
    expect(isVendoError(undefined)).toBe(false);
  });
});
