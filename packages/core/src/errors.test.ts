import { describe, expect, it } from "vitest";
import { VendoError } from "./index.js";

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
