import { describe, expect, it } from "vitest";
import { componentMapError } from "./component-map.js";
import { KIT_COMPONENT_NAMES } from "./kit/specs.js";
import {
  TREE_MAX_COMPONENT_SOURCE_CHARS,
  TREE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_TOTAL_COMPONENT_BYTES,
  TREE_MAX_TOTAL_COMPONENT_CHARS,
} from "./genui/tree-limits.js";

/** Internal generated-component map rules (01-core §8/§9). componentMapError is
 * not on the package root; it is the shared validator behind the tree + app
 * document validators, so it is pinned here directly. */
describe("componentMapError", () => {
  it("accepts an empty map and a well-formed PascalCase map", () => {
    expect(componentMapError({})).toBeNull();
    expect(componentMapError({ RevenueNote: "export default () => null", PriceTag: "const x = 1" })).toBeNull();
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

  /** V4 — one component family: the reserved set is the whole Kit, so an
   *  island can never shadow a built-in the renderer would resolve first. */
  it("rejects reserved (Kit component) names", () => {
    for (const reserved of ["Stack", "DataTable", "Card", "Tabs"]) {
      expect(KIT_COMPONENT_NAMES, `${reserved} must be a Kit name`).toContain(reserved);
      expect(componentMapError({ [reserved]: "x" })).toBe(
        `generated component name "${reserved}" is reserved (Kit component)`,
      );
    }
  });

  it("rejects a non-string source", () => {
    expect(componentMapError({ PriceTag: 42 as unknown as string })).toBe(
      'generated component "PriceTag" source must be a string',
    );
    expect(componentMapError({ PriceTag: { code: "x" } as unknown as string })).toContain(
      "source must be a string",
    );
  });

  it("rejects a single ASCII source over the per-component byte limit", () => {
    const tooBig = "a".repeat(TREE_MAX_COMPONENT_SOURCE_BYTES + 1);
    expect(componentMapError({ PriceTag: tooBig })).toBe(
      `generated component "PriceTag" source too large (max ${TREE_MAX_COMPONENT_SOURCE_BYTES} bytes)`,
    );
  });

  it("rejects total source size over the aggregate byte limit while each stays under its own", () => {
    const perComponent = "a".repeat(TREE_MAX_COMPONENT_SOURCE_BYTES);
    const needed = Math.floor(TREE_MAX_TOTAL_COMPONENT_BYTES / TREE_MAX_COMPONENT_SOURCE_BYTES) + 1;
    const map: Record<string, string> = {};
    for (let i = 0; i < needed; i += 1) map[`Comp${i}`] = perComponent;
    // Guard: stay within the count limit so the total-size branch is the one hit.
    expect(Object.keys(map).length).toBeLessThanOrEqual(TREE_MAX_GENERATED_COMPONENTS);
    expect(componentMapError(map)).toBe(
      `generated component sources too large in total (max ${TREE_MAX_TOTAL_COMPONENT_BYTES} bytes)`,
    );
  });
});

/** CORE-6 (wave 5): the contract pins the caps in BYTES (64 KB / 256 KB), not
 *  UTF-16 code units — multibyte sources must be measured encoded. */
describe("byte-based component caps", () => {
  it("rejects a source under the char count but over the 64 KB byte cap", () => {
    // "€" is one UTF-16 code unit but three UTF-8 bytes.
    const euros = "€".repeat(Math.floor(TREE_MAX_COMPONENT_SOURCE_BYTES / 3) + 1);
    expect(euros.length).toBeLessThan(TREE_MAX_COMPONENT_SOURCE_BYTES);
    expect(componentMapError({ PriceTag: euros })).toBe(
      `generated component "PriceTag" source too large (max ${TREE_MAX_COMPONENT_SOURCE_BYTES} bytes)`,
    );
  });

  it("rejects a multibyte total over 256 KB even when every source is under 64 KB", () => {
    const perComponent = "€".repeat(Math.floor((TREE_MAX_COMPONENT_SOURCE_BYTES - 3) / 3));
    const map: Record<string, string> = {};
    for (let i = 0; i < 5; i += 1) map[`Comp${i}`] = perComponent;
    expect(componentMapError(map)).toBe(
      `generated component sources too large in total (max ${TREE_MAX_TOTAL_COMPONENT_BYTES} bytes)`,
    );
  });

  it("keeps the char-named constants as byte-valued aliases for existing importers", () => {
    expect(TREE_MAX_COMPONENT_SOURCE_CHARS).toBe(TREE_MAX_COMPONENT_SOURCE_BYTES);
    expect(TREE_MAX_TOTAL_COMPONENT_CHARS).toBe(TREE_MAX_TOTAL_COMPONENT_BYTES);
  });
});
