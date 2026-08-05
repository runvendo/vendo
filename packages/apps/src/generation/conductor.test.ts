/**
 * The direct outcome's own fix-it loop (issue #822, defect 1): a direct
 * answer that reaches for a JS idiom the wire rejects (a method-call tool
 * name, an undeclared reference) used to be a single dead end — the one
 * outcome in conductCreate with no retry at all.
 */
import type { NormalizedCatalog } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { conductCreate } from "./conductor.js";
import { scriptedLanguageModel, type ScriptedModelCall } from "../testing/scripted-model.js";
import type { GenerationDependencies, HostToolInfo } from "./engine.js";

const catalog: NormalizedCatalog = [];

const tools: HostToolInfo[] = [
  { name: "host_listCities", description: "Weather for a set of named cities.", risk: "read" },
];

const depsWith = (...responses: Parameters<typeof scriptedLanguageModel>): GenerationDependencies => ({
  model: scriptedLanguageModel(...responses),
  catalog,
  tools,
});

const promptText = (call: ScriptedModelCall): string => call.prompt.map((message) => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text ?? "").join("");
}).join("\n");

// A JS-idiom mistake the wire rejects: "cities.map" is not a real tool.
const BROKEN = '<App name="Weather"><Query id="citiesMap" tool="cities.map"/><Text text="Paris"/></App>';
const FIXED = '<App name="Weather"><Query id="cities" tool="host_listCities"/><Text text={cities.0.name}/></App>';

describe("conductCreate — the direct outcome's fix-it loop", () => {
  it("retries a direct answer that fails to compile, feeding back exactly what was wrong, and ships the fixed one", async () => {
    const prompts: string[] = [];
    const result = await conductCreate({ prompt: "weather dashboard" }, depsWith((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? BROKEN : FIXED;
    }));

    // Calls beyond the second (the retry) are checkAndFix's own AI reviewer
    // pass over the now-valid app — a separate concern from this loop.
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[1]).toContain("does not compile");
    expect(prompts[1]).toContain(BROKEN);
    expect(prompts[1]).toContain('unknown tool "cities.map"');
    expect(result.kind).toBe("app");
  });

  it("gives up after FIX_ROUNDS retries instead of looping forever on a model that never fixes it", async () => {
    let calls = 0;
    const result = await conductCreate({ prompt: "weather dashboard" }, depsWith(() => {
      calls += 1;
      return BROKEN;
    }));

    // One first attempt plus FIX_ROUNDS retries — bounded, never unbounded.
    expect(calls).toBe(3);
    expect(result.kind).toBe("failure");
    expect(result.kind === "failure" && result.issues.some((issue) => issue.includes('unknown tool "cities.map"'))).toBe(true);
  });
});
