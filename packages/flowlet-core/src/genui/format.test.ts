import { describe, expect, it } from "vitest";
import {
  FLOWLET_GENUI_VERSION,
  isPropBinding,
  validateGeneratedPayload,
  type GeneratedPayload,
} from "./format";

const minimal = (): unknown => ({
  formatVersion: FLOWLET_GENUI_VERSION,
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
    const result = validateGeneratedPayload({ ...(minimal() as object), formatVersion: "flowlet-genui/v2" });
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
      formatVersion: FLOWLET_GENUI_VERSION,
      root: "n1",
      nodes: [{ id: "n1" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("rejects a node missing id with provision", () => {
    const result = validateGeneratedPayload({
      formatVersion: FLOWLET_GENUI_VERSION,
      root: "n1",
      nodes: [{ component: "Text" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("rejects a bad source value with provision", () => {
    const result = validateGeneratedPayload({
      formatVersion: FLOWLET_GENUI_VERSION,
      root: "n1",
      nodes: [{ id: "n1", component: "Text", source: "wired" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("rejects non-string children entries with provision", () => {
    const result = validateGeneratedPayload({
      formatVersion: FLOWLET_GENUI_VERSION,
      root: "n1",
      nodes: [{ id: "n1", component: "Stack", children: ["a", 2] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("rejects non-object props with provision", () => {
    const result = validateGeneratedPayload({
      formatVersion: FLOWLET_GENUI_VERSION,
      root: "n1",
      nodes: [{ id: "n1", component: "Text", props: [] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provision");
  });

  it("rejects duplicate node ids with provision", () => {
    const result = validateGeneratedPayload({
      formatVersion: FLOWLET_GENUI_VERSION,
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
      formatVersion: FLOWLET_GENUI_VERSION,
      root: "n1",
      nodes: [{ id: "n1", component: "Stack", children: ["n2-not-yet-streamed"] }],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts well-formed source, props, children, and data", () => {
    const result = validateGeneratedPayload({
      formatVersion: FLOWLET_GENUI_VERSION,
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
