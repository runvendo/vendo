/**
 * hostToolSections' TOOL RESPONSE SHAPES content — pinning the teaching
 * sentences a model reads before it writes a binding, since a wording
 * regression here is invisible to every other check.
 */
import type { ShapeType } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { scriptedLanguageModel } from "../../testing/scripted-model.js";
import type { GenerationDependencies } from "../engine.js";
import { hostToolSections } from "./sections.js";

const toolShapes: Record<string, ShapeType> = {
  host_listAccounts: { kind: "array", items: { kind: "object", fields: { balance: { kind: "number" } } } },
};

const deps: GenerationDependencies = {
  model: scriptedLanguageModel(() => '<App name="unused"/>'),
  catalog: [],
  toolShapes,
};

describe("hostToolSections", () => {
  it("teaches that a signed balance sums as-is, never filtered by kind or subtracted by hand", () => {
    const shapes = hostToolSections(deps).map(({ content }) => content).join("\n");
    expect(shapes).toContain("sums AS-IS across every row a total is meant to cover");
    expect(shapes).toContain("never filter a row out by its kind");
    expect(shapes).toContain("Math.abs()");
  });
});
