import { describe, it, expect } from "vitest";
import { SHELL_PACKAGE } from "./index";

describe("scaffold", () => {
  it("exports the package marker", () => {
    expect(SHELL_PACKAGE).toBe("@flowlet/shell");
  });
});
