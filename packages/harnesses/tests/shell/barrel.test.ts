/**
 * The shell is `vendo()`'s hand, so it leaves this package where the rest of
 * that harness's knobs do — `@vendoai/harnesses/vendo`. A sandbox harness
 * (`claudeCode()`) never imports it and must never see it.
 */
import { describe, expect, it } from "vitest";
import * as vendoSubpath from "../../src/vendo/index.js";

describe("the vendo subpath", () => {
  it("exports the shell's tool factory and its limits type", () => {
    expect(typeof vendoSubpath.createShellTools).toBe("function");
    expect(typeof vendoSubpath.createShellSession).toBe("function");
  });
});
