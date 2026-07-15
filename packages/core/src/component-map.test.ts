import { describe, expect, it } from "vitest";
import { componentMapError } from "./component-map.js";
import {
  RESERVED_COMPONENT_NAMES,
  TREE_MAX_COMPONENT_SOURCE_CHARS,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_TOTAL_COMPONENT_CHARS,
} from "./tree-limits.js";

/** Internal generated-component map rules (01-core §8/§9). componentMapError is
 * not on the package root; it is the shared validator behind the tree + app
 * document validators, so it is pinned here directly. */
describe("componentMapError", () => {
  it("accepts an empty map and a well-formed PascalCase map", () => {
    expect(componentMapError({})).toBeNull();
    expect(componentMapError({ Card: "export default () => null", PriceTag: "const x = 1" })).toBeNull();
  });

  it("rejects more than the pinned max number of components", () => {
    const map: Record<string, string> = {};
    for (let i = 0; i <= TREE_MAX_GENERATED_COMPONENTS; i += 1) map[`Comp${i}`] = "x";
    expect(Object.keys(map).length).toBeGreaterThan(TREE_MAX_GENERATED_COMPONENTS);
    expect(componentMapError(map)).toBe(
      `too many generated components (max ${TREE_MAX_GENERATED_COMPONENTS})`,
    );
  });

  it("rejects non-PascalCase names", () => {
    expect(componentMapError({ card: "x" })).toBe(
      'generated component name "card" must be a PascalCase identifier',
    );
    expect(componentMapError({ "My-Card": "x" })).toBe(
      'generated component name "My-Card" must be a PascalCase identifier',
    );
    expect(componentMapError({ "1Card": "x" })).toContain("PascalCase");
  });

  it("rejects reserved (prewired primitive) names", () => {
    const reserved = RESERVED_COMPONENT_NAMES[0];
    expect(reserved).toBeTruthy();
    expect(componentMapError({ [reserved]: "x" })).toBe(
      `generated component name "${reserved}" is reserved (prewired primitive)`,
    );
  });

  it("rejects a non-string source", () => {
    expect(componentMapError({ Card: 42 as unknown as string })).toBe(
      'generated component "Card" source must be a string',
    );
    expect(componentMapError({ Card: { code: "x" } as unknown as string })).toContain(
      "source must be a string",
    );
  });

  it("rejects a single source over the per-component char limit", () => {
    const tooBig = "a".repeat(TREE_MAX_COMPONENT_SOURCE_CHARS + 1);
    expect(componentMapError({ Card: tooBig })).toBe(
      `generated component "Card" source too large (max ${TREE_MAX_COMPONENT_SOURCE_CHARS} chars)`,
    );
  });

  it("rejects total source size over the aggregate char limit while each stays under its own", () => {
    const perComponent = "a".repeat(TREE_MAX_COMPONENT_SOURCE_CHARS);
    const needed = Math.floor(TREE_MAX_TOTAL_COMPONENT_CHARS / TREE_MAX_COMPONENT_SOURCE_CHARS) + 1;
    const map: Record<string, string> = {};
    for (let i = 0; i < needed; i += 1) map[`Comp${i}`] = perComponent;
    // Guard: stay within the count limit so the total-size branch is the one hit.
    expect(Object.keys(map).length).toBeLessThanOrEqual(TREE_MAX_GENERATED_COMPONENTS);
    expect(componentMapError(map)).toBe(
      `generated component sources too large in total (max ${TREE_MAX_TOTAL_COMPONENT_CHARS} chars)`,
    );
  });
});
