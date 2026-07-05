import { describe, expect, it } from "vitest";
import {
  VENDO_GENUI_VERSION,
  MAX_COMPONENT_SOURCE_CHARS,
  MAX_GENERATED_COMPONENTS,
  MAX_GENUI_QUERIES,
  isPropBinding,
  validateGeneratedPayload,
  type GenNode,
  type GeneratedPayload,
} from "./format";

const minimal = (): unknown => ({
  formatVersion: VENDO_GENUI_VERSION,
  root: "n1",
  nodes: [{ id: "n1", component: "Text" }],
});

describe("validateGeneratedPayload", () => {
  it("accepts a valid minimal single-node payload and narrows to ok:true", () => {
    const result = validateGeneratedPayload(minimal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      // type narrowing: payload is GeneratedPayload here
      const payload: GeneratedPayload = result.payload;
      expect(payload.root).toBe("n1");
      expect(payload.nodes).toHaveLength(1);
    }
  });

  it("rejects a non-object input with provision", () => {
    for (const bad of [null, undefined, 42, "x", true]) {
      const result = validateGeneratedPayload(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("provision");
    }
  });

  it("rejects a wrong formatVersion with version", () => {
    const result = validateGeneratedPayload({ ...(minimal() as object), formatVersion: "vendo-genui/v2" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("version");
  });

  it("rejects an absent formatVersion with version", () => {
    const { formatVersion, ...rest } = minimal() as Record<string, unknown>;
    void formatVersion;
    const result = validateGeneratedPayload(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("version");
  });

  it("rejects a missing root with provision", () => {
    const { root, ...rest } = minimal() as Record<string, unknown>;
    void root;
    const result = validateGeneratedPayload(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("rejects an empty root with provision", () => {
    const result = validateGeneratedPayload({ ...(minimal() as object), root: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("rejects a non-array nodes with provision", () => {
    const result = validateGeneratedPayload({ ...(minimal() as object), nodes: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("rejects a root id not among nodes with provision", () => {
    const result = validateGeneratedPayload({ ...(minimal() as object), root: "missing" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("rejects a node missing component with provision", () => {
    const result = validateGeneratedPayload({
      formatVersion: VENDO_GENUI_VERSION,
      root: "n1",
      nodes: [{ id: "n1" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("rejects a node missing id with provision", () => {
    const result = validateGeneratedPayload({
      formatVersion: VENDO_GENUI_VERSION,
      root: "n1",
      nodes: [{ component: "Text" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("rejects a bad source value with provision", () => {
    const result = validateGeneratedPayload({
      formatVersion: VENDO_GENUI_VERSION,
      root: "n1",
      nodes: [{ id: "n1", component: "Text", source: "wired" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("rejects non-string children entries with provision", () => {
    const result = validateGeneratedPayload({
      formatVersion: VENDO_GENUI_VERSION,
      root: "n1",
      nodes: [{ id: "n1", component: "Stack", children: ["a", 2] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("rejects non-object props with provision", () => {
    const result = validateGeneratedPayload({
      formatVersion: VENDO_GENUI_VERSION,
      root: "n1",
      nodes: [{ id: "n1", component: "Text", props: [] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("rejects an empty node id with provision", () => {
    const result = validateGeneratedPayload({
      formatVersion: VENDO_GENUI_VERSION,
      root: "n1",
      nodes: [{ id: "", component: "Text" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("rejects a non-object node element with provision", () => {
    for (const bad of [null, 42]) {
      const result = validateGeneratedPayload({
        formatVersion: VENDO_GENUI_VERSION,
        root: "n1",
        nodes: [bad],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("provision");
    }
  });

  it("rejects a non-object data with provision", () => {
    for (const bad of ["oops", 42, []]) {
      const result = validateGeneratedPayload({ ...(minimal() as object), data: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("provision");
    }
  });

  it("accepts an absent data and a plain-object data", () => {
    expect(validateGeneratedPayload(minimal()).ok).toBe(true);
    expect(
      validateGeneratedPayload({ ...(minimal() as object), data: { title: "Hi" } }).ok,
    ).toBe(true);
  });

  it("rejects duplicate node ids with provision", () => {
    const result = validateGeneratedPayload({
      formatVersion: VENDO_GENUI_VERSION,
      root: "n1",
      nodes: [
        { id: "n1", component: "Text" },
        { id: "n1", component: "Text" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("accepts a payload with a dangling child id (forward reference allowed)", () => {
    const result = validateGeneratedPayload({
      formatVersion: VENDO_GENUI_VERSION,
      root: "n1",
      nodes: [{ id: "n1", component: "Stack", children: ["n2-not-yet-streamed"] }],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts well-formed source, props, children, and data", () => {
    const result = validateGeneratedPayload({
      formatVersion: VENDO_GENUI_VERSION,
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "host", children: ["t"] },
        { id: "t", component: "Text", source: "prewired", props: { value: { $path: "/title" } } },
      ],
      data: { title: "Hello" },
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateGeneratedPayload — size bound (DoS)", () => {
  it("rejects a payload with more than 5000 nodes as a provision error", () => {
    const nodes = Array.from({ length: 5001 }, (_, i) => ({
      id: `n${i}`,
      component: "Text",
    }));
    const result = validateGeneratedPayload({
      formatVersion: VENDO_GENUI_VERSION,
      root: "n0",
      nodes,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("provision");
    expect(result.error.message).toContain("too many nodes");
  });

  it("accepts a payload at the 5000-node cap", () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => ({
      id: `n${i}`,
      component: "Text",
    }));
    const result = validateGeneratedPayload({
      formatVersion: VENDO_GENUI_VERSION,
      root: "n0",
      nodes,
    });
    expect(result.ok).toBe(true);
  });
});

describe("isPropBinding", () => {
  it("is true for a { $path } object with a string path", () => {
    expect(isPropBinding({ $path: "/a" })).toBe(true);
  });

  it("is false for a plain string, null, and an empty object", () => {
    expect(isPropBinding("/a")).toBe(false);
    expect(isPropBinding(null)).toBe(false);
    expect(isPropBinding({})).toBe(false);
  });

  it("is false when $path is not a string", () => {
    expect(isPropBinding({ $path: 5 })).toBe(false);
  });
});

describe("generated components (Tier 2.5)", () => {
  const base = {
    formatVersion: "vendo-genui/v1",
    root: "r",
    nodes: [{ id: "r", component: "Gauge", source: "generated" }],
  };
  const CODE = "import React from 'react'; export default function Gauge(){ return React.createElement('div'); }";

  it("accepts a payload whose generated node has a matching components entry", () => {
    const v = validateGeneratedPayload({ ...base, components: { Gauge: CODE } });
    expect(v.ok).toBe(true);
  });

  it("still accepts payloads with no components field (backwards compatible)", () => {
    const v = validateGeneratedPayload({
      formatVersion: "vendo-genui/v1",
      root: "r",
      nodes: [{ id: "r", component: "Text", source: "prewired" }],
    });
    expect(v.ok).toBe(true);
  });

  it("rejects a generated-source node with no matching components entry", () => {
    const v = validateGeneratedPayload({ ...base, components: {} });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.code).toBe("provision");
  });

  it("rejects a component name that is not PascalCase-identifier shaped", () => {
    const v = validateGeneratedPayload({
      ...base,
      nodes: [{ id: "r", component: "bad-name", source: "generated" }],
      components: { "bad-name": CODE },
    });
    expect(v.ok).toBe(false);
  });

  it("rejects a component name that shadows a prewired primitive", () => {
    const v = validateGeneratedPayload({
      ...base,
      nodes: [{ id: "r", component: "Text", source: "generated" }],
      components: { Text: CODE },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.message).toContain("reserved");
  });

  it("rejects non-string component source", () => {
    const v = validateGeneratedPayload({ ...base, components: { Gauge: 42 } });
    expect(v.ok).toBe(false);
  });

  it("enforces the per-component source-size cap", () => {
    const big = "x".repeat(MAX_COMPONENT_SOURCE_CHARS + 1);
    const v = validateGeneratedPayload({ ...base, components: { Gauge: big } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.message).toContain("source too large");
  });

  it("accepts a source at exactly the per-component cap", () => {
    const atCap = "x".repeat(MAX_COMPONENT_SOURCE_CHARS);
    const v = validateGeneratedPayload({ ...base, components: { Gauge: atCap } });
    expect(v.ok).toBe(true);
  });

  it("enforces the total source-size cap (exactly at cap accepted, one char over rejected)", () => {
    // 4 components at exactly the per-component cap = exactly the total cap.
    const atCap = "x".repeat(MAX_COMPONENT_SOURCE_CHARS);
    const four = { Gauge: atCap, A: atCap, B: atCap, C: atCap };
    expect(validateGeneratedPayload({ ...base, components: four }).ok).toBe(true);
    // A fifth 1-char component pushes the total one char over the cap.
    const v = validateGeneratedPayload({ ...base, components: { ...four, D: "x" } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.message).toContain("sources too large in total");
  });

  it("enforces the component-count cap", () => {
    const components: Record<string, string> = { Gauge: CODE };
    for (let i = 0; i <= MAX_GENERATED_COMPONENTS; i++) components[`C${i}`] = CODE;
    const v = validateGeneratedPayload({ ...base, components });
    expect(v.ok).toBe(false);
  });

  it("accepts exactly the component-count cap", () => {
    const components: Record<string, string> = { Gauge: CODE };
    for (let i = 0; i < MAX_GENERATED_COMPONENTS - 1; i++) components[`C${i}`] = CODE;
    expect(Object.keys(components)).toHaveLength(MAX_GENERATED_COMPONENTS);
    const v = validateGeneratedPayload({ ...base, components });
    expect(v.ok).toBe(true);
  });

  it("accepts source: 'generated' in the node source union", () => {
    const n: GenNode = { id: "x", component: "Gauge", source: "generated" };
    expect(n.source).toBe("generated");
  });

  it("accepts a payload with valid queries", () => {
    const result = validateGeneratedPayload({
      ...(minimal() as object),
      data: { tx: [] },
      queries: [{ path: "/tx", tool: "get_transactions", input: { limit: 40 } }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.queries).toHaveLength(1);
  });

  it("accepts an empty-pointer query path and an input-less query", () => {
    const result = validateGeneratedPayload({
      ...(minimal() as object),
      queries: [{ path: "", tool: "get_transactions" }],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects malformed queries with provision", () => {
    const bads: unknown[] = [
      "nope", // not an array
      [{ path: "tx", tool: "t" }], // pointer missing leading /
      [{ path: "/tx", tool: "" }], // empty tool
      [{ path: "/tx", tool: "t", input: "x" }], // non-object input
      [{ path: "/tx" }], // missing tool
      Array.from({ length: MAX_GENUI_QUERIES + 1 }, () => ({ path: "/t", tool: "t" })), // over cap
    ];
    for (const queries of bads) {
      const result = validateGeneratedPayload({ ...(minimal() as object), queries });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("provision");
    }
  });
});
