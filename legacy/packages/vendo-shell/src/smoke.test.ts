import { describe, it, expect } from "vitest";
import { VendoPage } from "./index";

describe("scaffold", () => {
  it("exports the page surface", () => {
    expect(typeof VendoPage).toBe("function");
  });
});
