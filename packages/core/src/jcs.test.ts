import { describe, expect, it } from "vitest";
import { VendoError, canonicalJson, sha256Hex } from "./index.js";

describe("sha256Hex", () => {
  it("matches the empty-string ground truth", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches the abc ground truth", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("canonicalJson", () => {
  it("sorts RFC 8785 unicode property names by UTF-16 code units", () => {
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
});
