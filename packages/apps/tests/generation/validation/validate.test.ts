/**
 * validateCompiledCreate (generation pipeline, create path). The direct path
 * (the brain writing a whole app in one shot, conductor.ts's documentFromWire)
 * has no fill worker and no spliceFragment to catch it copying its OWN plan
 * vocabulary — skeleton.ts's withoutPlanVocabulary — so the same defence has
 * to run here too, before any check reads the compiled tree.
 */
import { compileWire, type NormalizedCatalog } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { scriptedLanguageModel } from "../../../src/testing/scripted-model.js";
import { asTree, type GenerationDependencies, type HostToolInfo } from "../../../src/generation/engine.js";
import { validateCompiledCreate } from "../../../src/generation/validation/validate.js";

const catalog: NormalizedCatalog = [];
const tools: HostToolInfo[] = [];

const deps = (): GenerationDependencies => ({
  model: scriptedLanguageModel(() => '<App name="unused"/>'),
  catalog,
  tools,
});

describe("validateCompiledCreate", () => {
  it("resolves a direct-mode <Leaf component=...>/<Group> copy-paste instead of failing it as an unknown component", async () => {
    const wire = '<App name="Balance"><Group><Leaf component="Text" query="accounts" purpose="the balance" text="All good"/></Group></App>';
    const compiled = compileWire(wire, {});
    const { document, issues } = await validateCompiledCreate(compiled, deps());
    expect(issues).toEqual([]);
    const nodes = asTree(document?.tree as NonNullable<typeof document>["tree"]).nodes;
    expect(nodes.map((node) => node.component).sort()).toEqual(["Stack", "Stack", "Text"]);
    expect(nodes.find((node) => node.component === "Text")?.props).toEqual({ text: "All good" });
  });
});
