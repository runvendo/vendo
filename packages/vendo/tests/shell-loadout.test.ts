import { VENDO_BASH_TOOL } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { PROMPT_TAUGHT_TOOLS } from "../src/compose-harness.js";

describe("the shell and the loadout cap", () => {
  it("is named as prompt-taught, so the cap never hides it", () => {
    expect(PROMPT_TAUGHT_TOOLS).toContain(VENDO_BASH_TOOL);
  });
});
