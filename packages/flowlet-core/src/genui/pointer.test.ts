import { describe, expect, it } from "vitest";
import { applyPointerPatch, resolvePointer } from "./pointer";

describe("resolvePointer", () => {
  const data = {
    a: { b: { c: 42 } },
    list: [10, 20, { x: "y" }],
    "a/b": "slash-key",
    "m~n": "tilde-key",
    prim: "hello",
  };

  it("returns the whole data for the empty pointer", () => {
    expect(resolvePointer(data, "")).toBe(data);
  });

  it("resolves a nested object path", () => {
    expect(resolvePointer(data, "/a/b/c")).toBe(42);
  });

  it("resolves an array index", () => {
    expect(resolvePointer(data, "/list/1")).toBe(20);
    expect(resolvePointer(data, "/list/2/x")).toBe("y");
  });

  it("unescapes ~1 to / in a reference token", () => {
    expect(resolvePointer(data, "/a~1b")).toBe("slash-key");
  });

  it("unescapes ~0 to ~ in a reference token", () => {
    expect(resolvePointer(data, "/m~0n")).toBe("tilde-key");
  });

  it("returns undefined for an unknown key", () => {
    expect(resolvePointer(data, "/a/nope")).toBeUndefined();
  });

  it("returns undefined for an out-of-range array index", () => {
    expect(resolvePointer(data, "/list/9")).toBeUndefined();
  });

  it("returns undefined when descending into a primitive", () => {
    expect(resolvePointer(data, "/prim/0")).toBeUndefined();
  });

  it("returns undefined for a pointer that does not start with /", () => {
    expect(resolvePointer(data, "a/b")).toBeUndefined();
  });
});

describe("applyPointerPatch", () => {
  it("sets a deep value without mutating the original", () => {
    const original = { a: { b: { c: 1 } }, sibling: { keep: true } };
    const snapshot = structuredClone(original);

    const next = applyPointerPatch(original, "/a/b/c", 99);

    expect(next.a).toEqual({ b: { c: 99 } });
    expect(original).toEqual(snapshot);
    // structural sharing: untouched sibling subtree is the same reference
    expect((next as typeof original).sibling).toBe(original.sibling);
  });

  it("creates a missing intermediate object", () => {
    const original = { a: {} as Record<string, unknown> };
    const next = applyPointerPatch(original, "/a/b/c", 7);
    expect(next).toEqual({ a: { b: { c: 7 } } });
  });

  it("deletes an object key when value is omitted", () => {
    const original = { a: { keep: 1, drop: 2 } };
    const next = applyPointerPatch(original, "/a/drop");
    expect(next).toEqual({ a: { keep: 1 } });
    expect(original).toEqual({ a: { keep: 1, drop: 2 } });
  });

  it("deletes an array element and shifts the rest", () => {
    const original = { list: [10, 20, 30] };
    const next = applyPointerPatch(original, "/list/1");
    expect(next).toEqual({ list: [10, 30] });
    expect(original).toEqual({ list: [10, 20, 30] });
  });

  it("replaces an array element when setting an in-range index", () => {
    const original = { list: [10, 20, 30] };
    const next = applyPointerPatch(original, "/list/1", 99);
    expect(next).toEqual({ list: [10, 99, 30] });
  });

  it("appends when setting an array index equal to the length", () => {
    const original = { list: [10, 20] };
    const next = applyPointerPatch(original, "/list/2", 30);
    expect(next).toEqual({ list: [10, 20, 30] });
  });

  it("ignores an out-of-range array set beyond the length", () => {
    const original = { list: [10, 20] };
    const next = applyPointerPatch(original, "/list/9", 30);
    expect(next).toEqual({ list: [10, 20] });
  });

  it("replaces the whole model when patching the root with a value", () => {
    const original = { a: 1 };
    const next = applyPointerPatch(original, "", { b: 2 });
    expect(next).toEqual({ b: 2 });
  });

  it("treats a root delete as a no-op", () => {
    const original = { a: 1 };
    const next = applyPointerPatch(original, "");
    expect(next).toBe(original);
  });

  it("unescapes ~1 and ~0 in patch tokens", () => {
    const original = {} as Record<string, unknown>;
    const next = applyPointerPatch(original, "/a~1b", 1);
    expect(next).toEqual({ "a/b": 1 });
  });
});
