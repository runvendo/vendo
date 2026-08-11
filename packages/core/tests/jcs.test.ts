import { describe, expect, it } from "vitest";
import { VendoError, canonicalJson, sha256Hex } from "../src/index.js";

describe("sha256Hex", () => {
  it("matches the empty-string ground truth", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches the abc ground truth", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

// canonicalJson is the serializer feeding every content hash. A value that
// serializes ambiguously (or differently across implementations) would let two
// logically distinct payloads collide, or the same payload hash differently on
// two hosts. The contract is fail-closed: anything that is not well-formed JSON
// data THROWS rather than being silently coerced.
describe("canonicalJson", () => {
  it("sorts RFC 8785 unicode property names by UTF-16 code units", () => {
    // U+1F600 GRINNING FACE is D83D DE00 in UTF-16; its first code unit (D83D) is
    // BELOW U+FB33 (HEBREW LETTER DALET WITH DAGESH, a single BMP unit), so a
    // per-code-UNIT sort places the emoji key first. A per-code-POINT sort would
    // place U+1F600 after U+FB33 — this vector pins the former.
    const value = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    expect(canonicalJson(value)).toBe(
      "{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\":\"Control\",\"ö\":\"Latin Small Letter O With Diaeresis\",\"€\":\"Euro Sign\",\"😀\":\"Emoji: Grinning Face\",\"דּ\":\"Hebrew Letter Dalet With Dagesh\"}",
    );
  });

  it("uses ECMAScript number serialization", () => {
    expect(canonicalJson([1e30, 0.000001, 1e-7, 1e1, -0])).toBe("[1e+30,0.000001,1e-7,10,0]");
  });

  it("uses JSON string escaping and recursively canonicalizes structures", () => {
    expect(canonicalJson({ z: [true, { b: "line\n\"quote\"", a: null }], a: "\\" })).toBe(
      "{\"a\":\"\\\\\",\"z\":[true,{\"a\":null,\"b\":\"line\\n\\\"quote\\\"\"}]}",
    );
  });

  it("follows ECMAScript omission and array-null semantics", () => {
    expect(canonicalJson({ b: undefined, a: 1, c: () => 1 })).toBe("{\"a\":1}");
    expect(canonicalJson([undefined, () => 1, 2])).toBe("[null,null,2]");
    expect(canonicalJson(new Array(2))).toBe("[null,null]");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1n])(
    "throws VendoError for unsupported numeric value %s",
    (value) => {
      expect(() => canonicalJson(value)).toThrow(VendoError);
      try {
        canonicalJson(value);
      } catch (error) {
        expect(error).toMatchObject({ code: "validation" });
      }
    },
  );

  it("rejects lone surrogates in strings and keys (RFC 8785 well-formedness)", () => {
    expect(() => canonicalJson("broken \ud800 surrogate")).toThrow(VendoError);
    expect(() => canonicalJson("tail \udfff")).toThrow(VendoError);
    expect(() => canonicalJson({ ["k\ud800"]: 1 })).toThrow(VendoError);
    expect(canonicalJson("paired 😀 fine")).toBe("\"paired 😀 fine\"");
  });

  it("rejects non-plain objects instead of silently mis-serializing them", () => {
    for (const value of [new Date(0), new Map(), /x/, new Uint8Array([1])]) {
      expect(() => canonicalJson(value)).toThrow(VendoError);
    }
    expect(canonicalJson(Object.create(null, { a: { value: 1, enumerable: true } }))).toBe("{\"a\":1}");
  });

  // A rejection that only fires at the top level is no protection at all: every
  // real payload nests, so each refusal is re-checked inside an object and an
  // array.
  it("rejects a refused value wherever it is nested", () => {
    class Widget {
      readonly kind = "widget";
    }
    const refused: unknown[] = [
      "\udc00 low", Number.NaN, Number.POSITIVE_INFINITY, 9007199254740993n,
      new Date(0), new Map([["a", 1]]), new Set([1]), /pattern/, new Widget(),
    ];
    for (const value of refused) {
      expect(() => canonicalJson({ nested: value })).toThrow(VendoError);
      expect(() => canonicalJson([value])).toThrow(VendoError);
    }
  });

  it("rejects cyclic objects and cyclic arrays instead of recursing forever", () => {
    const cyclicObject: Record<string, unknown> = {};
    cyclicObject.self = cyclicObject;
    expect(() => canonicalJson(cyclicObject)).toThrow(VendoError);

    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    expect(() => canonicalJson(cyclicArray)).toThrow(VendoError);
  });
});
