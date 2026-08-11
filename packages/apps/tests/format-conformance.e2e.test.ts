/**
 * THE FORMAT CONSTITUTION.
 *
 * The app format has mirrors — the contract, `@vendoai/core`'s pinned limits,
 * the manual the model reads (`skills/format-reference.ts`) and the public docs
 * page. Every one of them used to be maintained by hand, and they disagreed: the
 * manual promised "16 islands, 64 KB each" and never mentioned the 256 KB TOTAL
 * the validator also enforces, so a model that obeyed the manual could write a
 * megabyte of islands and watch the whole app fail to validate for a reason it
 * was never told about.
 *
 * The manual is no longer one of those mirrors for the byte budgets: a screen is
 * `app.tsx` now and has no byte budget, so what is asserted of the manual here is
 * that it quotes none. The budgets themselves still bind stored wire documents,
 * so core, the contract and the docs page still have to agree.
 *
 * This file is the one place a format number or a component name is written by
 * hand. Everything else derives, and this test fails the moment any mirror
 * drifts from another — a test, not a convention.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  TREE_MAX_COMPONENT_SOURCE_BYTES as CORE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_GENERATED_COMPONENTS as CORE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_TOTAL_COMPONENT_BYTES as CORE_MAX_TOTAL_COMPONENT_BYTES,
} from "@vendoai/core";
import {
  KIT_COMPONENT_NAMES,
  KIT_SPECS,
  KIT_WIRE_COMPONENT_NAMES,
  KIT_WIRE_UNSAFE_NAMES,
  TREE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_TOTAL_COMPONENT_BYTES,
  WIRE_COMPONENT_NAMES,
} from "../src/contract/index.js";
import { VENDO_FORMAT_REFERENCE } from "../src/server/skills/format-reference.js";

const KB = 1_024;

/** d4 — the three bundle budgets, stated once, here. Changing any of them is a
 *  format change, and it has to be made in this file first. */
const LIMITS = {
  generatedComponents: 16,
  componentSourceBytes: 64 * KB,
  totalComponentBytes: 256 * KB,
} as const;

/** The component vocabulary a generated app may name without a source map. */
const VOCABULARY = [
  "Accordion", "Badge", "BarChart", "Button", "Callout", "Card", "CardList", "Checkbox", "DataTable",
  "DatePicker", "DateTime", "Disclaimer", "Divider", "DonutChart", "EnumBadge", "Form", "Grid", "Input",
  "LineChart", "Money", "Num", "Percent", "Progress", "Row", "Select", "Sparkline", "Stack", "Stat",
  "Surface", "Tabs", "Text", "Textarea",
];

const DOCS_FORMAT_PAGE = readFileSync(
  new URL("../../../docs-site/concepts/generated-ui.mdx", import.meta.url),
  "utf8",
);

describe("the three bundle limits have ONE definition", () => {
  it("core holds the values this file pins", () => {
    expect(CORE_MAX_GENERATED_COMPONENTS).toBe(LIMITS.generatedComponents);
    expect(CORE_MAX_COMPONENT_SOURCE_BYTES).toBe(LIMITS.componentSourceBytes);
    expect(CORE_MAX_TOTAL_COMPONENT_BYTES).toBe(LIMITS.totalComponentBytes);
  });

  it("the contract re-exports core's constants rather than re-declaring them", () => {
    expect(TREE_MAX_GENERATED_COMPONENTS).toBe(CORE_MAX_GENERATED_COMPONENTS);
    expect(TREE_MAX_COMPONENT_SOURCE_BYTES).toBe(CORE_MAX_COMPONENT_SOURCE_BYTES);
    expect(TREE_MAX_TOTAL_COMPONENT_BYTES).toBe(CORE_MAX_TOTAL_COMPONENT_BYTES);
  });
});

describe("the manual states no budget, because the artifact it teaches has none", () => {
  it("quotes no KB figure at all", () => {
    // The three limits above govern the WIRE dialect's islands
    // (`contract/component-map.ts`), and nothing generates one any more: the
    // artifact a model writes is `app.tsx`, which the save-time gauntlet
    // (`checking/component-screen.ts`) measures for compilation, types and one
    // real render — never for bytes. A KB sentence in this manual would teach a
    // budget nothing enforces on the file it is about, which is this file's own
    // failure mode pointed the other way.
    expect(VENDO_FORMAT_REFERENCE).not.toMatch(/\d+ KB/);
  });
});

describe("the public docs page states the same format", () => {
  it("quotes the three limits the validator enforces", () => {
    const stated = /at most \*\*(\d+)\*\* generated components, each at most\s+\*\*(\d+) KB\*\* of source, and \*\*(\d+) KB\*\* across all of them/
      .exec(DOCS_FORMAT_PAGE);
    expect(stated, "docs-site/concepts/generated-ui.mdx must state the three component limits").not.toBeNull();
    expect([Number(stated?.[1]), Number(stated?.[2]) * KB, Number(stated?.[3]) * KB]).toEqual([
      TREE_MAX_GENERATED_COMPONENTS,
      TREE_MAX_COMPONENT_SOURCE_BYTES,
      TREE_MAX_TOTAL_COMPONENT_BYTES,
    ]);
  });
});

describe("the component vocabulary is ONE list", () => {
  it("is the list this file pins", () => {
    expect([...KIT_COMPONENT_NAMES].sort()).toEqual(VOCABULARY);
  });

  it("derives from the specs — nothing recomputes it", () => {
    expect(KIT_COMPONENT_NAMES).toEqual(KIT_SPECS.map((spec) => spec.name));
  });

  it("names the wire subset once, under two names", () => {
    // WIRE_COMPONENT_NAMES is KIT_WIRE_COMPONENT_NAMES re-exported: the same
    // binding, so the two can never say different things.
    expect(WIRE_COMPONENT_NAMES).toBe(KIT_WIRE_COMPONENT_NAMES);
    expect(KIT_WIRE_COMPONENT_NAMES).toEqual(
      KIT_COMPONENT_NAMES.filter((name) => !KIT_WIRE_UNSAFE_NAMES.includes(name)),
    );
  });
});
