import { describe, expect, it } from "vitest";
import { VendoError, canonicalJson } from "../index.js";

// Adversarial regression suite for canonicalJson (01-core §4, RFC 8785). This is
// the serializer feeding every content hash. A value that serializes
// ambiguously (or differently across implementations) would let two logically
// distinct payloads collide, or the same payload hash differently on two hosts.
// The contract is fail-closed: anything not well-formed JSON data THROWS rather
// than being silently coerced. Non-ASCII test data is built with fromCharCode so
// the source stays pure ASCII (no decomposed/precomposed literal ambiguity).

const expectRejected = (value: unknown): void => {
  expect(() => canonicalJson(value)).toThrow(VendoError);
};

describe("canonicalJson rejects non-canonicalizable values", () => {
  it("rejects lone surrogate strings (top-level, nested, and as keys)", () => {
    expectRejected("\ud800");
    expectRejected("trailing \udfff end");
    expectRejected({ nested: "\udc00 low" });
    expectRejected({ ["key\ud834"]: 1 });
    expectRejected(["\ud83d"]); // unpaired high surrogate inside an array
  });

  it("accepts a correctly paired surrogate (astral character)", () => {
    const grin = String.fromCharCode(0xd83d, 0xde00);
    expect(canonicalJson(`emoji ${grin} ok`)).toBe(`"emoji ${grin} ok"`);
  });

  it("rejects non-finite numbers", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expectRejected(value);
      expectRejected({ n: value });
      expectRejected([value]);
    }
  });

  it("rejects bigint", () => {
    expectRejected(10n);
    expectRejected({ big: 9007199254740993n });
  });

  it("rejects Date, Map, Set, RegExp, and class instances", () => {
    class Widget {
      readonly kind = "widget";
    }
    for (const value of [new Date(0), new Map([["a", 1]]), new Set([1]), /pattern/, new Widget()]) {
      expectRejected(value);
      expectRejected({ wrapped: value });
    }
  });

  it("rejects cyclic objects and cyclic arrays", () => {
    const cyclicObject: Record<string, unknown> = {};
    cyclicObject.self = cyclicObject;
    expectRejected(cyclicObject);

    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    expectRejected(cyclicArray);
  });

  it("surfaces every rejection as a VendoError with code validation (no oracle detail)", () => {
    try {
      canonicalJson(new Date(0));
      throw new Error("expected canonicalJson to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(VendoError);
      expect((error as VendoError).code).toBe("validation");
    }
  });
});

describe("canonicalJson key ordering", () => {
  it("sorts object keys by UTF-16 code unit, not by code point or locale", () => {
    // U+1F600 GRINNING FACE is D83D DE00 in UTF-16; its first code unit (D83D) is
    // BELOW U+FB33 (HEBREW LETTER DALET WITH DAGESH, a single BMP unit), so a
    // per-code-UNIT sort places the emoji key first. A per-code-POINT sort would
    // place U+1F600 after U+FB33 — this vector pins the former.
    const grin = String.fromCharCode(0xd83d, 0xde00);
    const dalet = String.fromCharCode(0xfb33);
    const value: Record<string, string> = {
      [dalet]: "dalet",
      b: "bee",
      [grin]: "grin",
      A: "cap-a",
      "1": "one",
    };
    expect(canonicalJson(value)).toBe(
      `{"1":"one","A":"cap-a","b":"bee","${grin}":"grin","${dalet}":"dalet"}`,
    );
  });
});
