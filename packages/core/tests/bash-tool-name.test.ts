/**
 * The shell's name and its human title live in core for the reason every other
 * `vendo_*` name does: two sides read them — the registry in `@vendoai/harnesses`
 * that implements the tool, and the surfaces that show it to a person.
 */
import { describe, expect, it } from "vitest";
import { VENDO_BASH_TOOL, VENDO_TOOL_TITLES } from "../src/tools.js";

describe("the shell tool's name", () => {
  it("is `bash`, and has a title a person can read", () => {
    expect(VENDO_BASH_TOOL).toBe("bash");
    expect(VENDO_TOOL_TITLES[VENDO_BASH_TOOL]).toBe("Work on your files");
  });
});
