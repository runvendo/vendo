/**
 * hostToolSections' TOOL RESPONSE SHAPES content — pinning the teaching
 * sentences a model reads before it writes a binding, since a wording
 * regression here is invisible to every other check.
 */
import { KIT_COMPONENT_NAMES, type ShapeType } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { scriptedLanguageModel } from "../../testing/scripted-model.js";
import type { GenerationDependencies } from "../engine.js";
import { hostToolSections, islandContract } from "./sections.js";

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

  /**
   * V4 retired the legacy prewired family — the Kit is the ONE component
   * source, and the tabular component is DataTable. A prompt that still writes
   * "Table" teaches a name nothing resolves: the wire compiler leaves it
   * unknown, the renderer has no component for it, and the model's binding is
   * spent on a node that never paints.
   */
  it("never teaches a retired component name — the tabular Kit component is DataTable", () => {
    const shapes = hostToolSections(deps).map(({ content }) => content).join("\n");
    const retired = shapes.replaceAll("DataTable", "").match(/\bTable\b/g) ?? [];
    expect(retired, `hostToolSections still names the retired "Table" component ${retired.length}x`).toEqual([]);
    expect(KIT_COMPONENT_NAMES).not.toContain("Table");
  });
});

/**
 * The island scope contract. V4 made the built-in (prewired) vocabulary a
 * SUBSET of the ambient Kit — `prepareIslands` proves it by filtering
 * WIRE_COMPONENT_NAMES out of its host-only rejection set — so the only names
 * genuinely out of island scope are the HOST catalog's, which live in the host
 * page and can never cross into the jail.
 */
describe("islandContract", () => {
  it("does not tell the model prewired components are out of island scope — they are ambient", () => {
    const contract = islandContract();
    // The prewired/built-in set IS the ambient Kit, so this sentence is false.
    expect(contract).not.toContain("prewired components are NOT in island scope");
    // What IS true: the host catalog is the thing that cannot cross the jail.
    expect(contract).toContain("Host catalog components are NOT in island scope");
  });
});
