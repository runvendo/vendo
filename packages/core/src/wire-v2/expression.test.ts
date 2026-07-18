import { describe, expect, it } from "vitest";
import { parseExpression, type ExpressionContext } from "./expression.js";

const context: ExpressionContext = { queryNames: new Set(["revenue", "payments"]) };

const parse = (source: string) => parseExpression(source, context);

const expectValue = (source: string, value: unknown): void => {
  const result = parse(source);
  expect(result.dropped).toBe(false);
  expect(result.value).toEqual(value);
  expect(result.issues).toEqual([]);
};

const expectDropped = (source: string, code: string): void => {
  const result = parse(source);
  expect(result.dropped).toBe(true);
  expect(result.value).toBeUndefined();
  expect(result.issues.length).toBeGreaterThan(0);
  expect(result.issues.map((issue) => issue.code)).toContain(code);
};

describe("parseExpression literals", () => {
  it("parses integers, floats, negatives, and exponents", () => {
    expectValue("5", 5);
    expectValue("0", 0);
    expectValue("3.14", 3.14);
    expectValue("-2", -2);
    expectValue("-0.5", -0.5);
    expectValue("1e3", 1000);
    expectValue("2.5E-2", 0.025);
  });

  it("rejects non-JSON number spellings", () => {
    expectDropped("+5", "malformed-expression");
    expectDropped(".5", "malformed-expression");
    expectDropped("05", "malformed-expression");
    expectDropped("1.", "malformed-expression");
    expectDropped("-", "malformed-expression");
  });

  it("parses double- and single-quoted strings", () => {
    expectValue('"hello"', "hello");
    expectValue("'hello'", "hello");
    expectValue("\"it's fine\"", "it's fine");
    expectValue("''", "");
  });

  it("handles backslash escapes for quotes, backslash, \\n, and \\t", () => {
    expectValue('"say \\"hi\\""', 'say "hi"');
    expectValue("'it\\'s'", "it's");
    expectValue('"a\\\\b"', "a\\b");
    expectValue('"line\\nbreak"', "line\nbreak");
    expectValue('"tab\\tstop"', "tab\tstop");
  });

  it("passes an unknown escape through as the escaped character", () => {
    expectValue('"\\q"', "q");
  });

  it("preserves unicode in strings", () => {
    expectValue('"héllo wörld 🚀"', "héllo wörld 🚀");
  });

  it("parses true, false, and null keywords", () => {
    expectValue("true", true);
    expectValue("false", false);
    expectValue("null", null);
  });

  it("tolerates surrounding whitespace", () => {
    expectValue("  5  ", 5);
    expectValue("\n\ttrue\n", true);
  });
});

describe("parseExpression arrays and objects", () => {
  it("parses arrays, including nested and mixed", () => {
    expectValue("[]", []);
    expectValue("[1, 2, 3]", [1, 2, 3]);
    expectValue('[1, "a", true, null]', [1, "a", true, null]);
    expectValue("[1, [2, [3]]]", [1, [2, [3]]]);
  });

  it("tolerates trailing commas in arrays", () => {
    expectValue("[1, 2,]", [1, 2]);
    expectValue("[1,]", [1]);
  });

  it("parses objects with bare and quoted keys", () => {
    expectValue("{}", {});
    expectValue("{ limit: 5 }", { limit: 5 });
    expectValue('{ "quoted key": 1, bare: 2 }', { "quoted key": 1, bare: 2 });
    expectValue("{ 'single': 3 }", { single: 3 });
  });

  it("tolerates trailing commas in objects", () => {
    expectValue("{ a: 1, }", { a: 1 });
  });

  it("parses nested object/array combinations", () => {
    expectValue('{ a: { b: [1, { c: "d" }] } }', { a: { b: [1, { c: "d" }] } });
  });

  it("treats a __proto__ key as data, never as the result's prototype", () => {
    for (const source of ['{ __proto__: { evil: true }, a: 1 }', '{ "__proto__": { evil: true }, a: 1 }']) {
      const result = parse(source);
      expect(result.dropped).toBe(false);
      const value = result.value as Record<string, unknown>;
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(Object.getOwnPropertyNames(value)).toEqual(["__proto__", "a"]);
      expect(value.a).toBe(1);
    }
  });

  it("does not treat reserved reference words as special in key position", () => {
    expectValue("{ state: 1, revenue: 2, true: 3 }", { state: 1, revenue: 2, true: 3 });
  });
});

describe("parseExpression bindings", () => {
  it("compiles a bare query name to a $path binding", () => {
    expectValue("revenue", { $path: "/revenue" });
  });

  it("compiles a dotted query path to a pointer with segments", () => {
    expectValue("revenue.total", { $path: "/revenue/total" });
    expectValue("payments.items.amount", { $path: "/payments/items/amount" });
  });

  it("compiles state.<key> to a $state binding", () => {
    expectValue("state.filter", { $state: "filter" });
  });

  it("drops bare `state` with state-depth-unsupported", () => {
    expectDropped("state", "state-depth-unsupported");
  });

  it("drops state.a.b with state-depth-unsupported", () => {
    expectDropped("state.a.b", "state-depth-unsupported");
  });

  it("drops unknown identifiers with unknown-reference naming the identifier", () => {
    const result = parse("mystery");
    expect(result.dropped).toBe(true);
    expect(result.issues.map((issue) => issue.code)).toContain("unknown-reference");
    expect(result.issues[0]?.message).toContain("mystery");
  });

  it("names the full dotted path in unknown-reference issues", () => {
    const result = parse("mystery.total");
    expect(result.dropped).toBe(true);
    expect(result.issues[0]?.message).toContain("mystery.total");
  });

  it("compiles bindings nested inside arrays and objects", () => {
    expectValue("[revenue, state.tab]", [{ $path: "/revenue" }, { $state: "tab" }]);
    expectValue("{ points: revenue.total, active: state.tab }", {
      points: { $path: "/revenue/total" },
      active: { $state: "tab" },
    });
  });

  it("drops the whole attribute value when a nested reference is unknown", () => {
    expectDropped("[1, mystery]", "unknown-reference");
    expectDropped("{ a: mystery }", "unknown-reference");
    expectDropped("{ a: [1, { b: mystery }] }", "unknown-reference");
  });

  it("rejects non-identifier path segments", () => {
    expectDropped("revenue.0", "malformed-expression");
    expectDropped("revenue.", "malformed-expression");
  });
});

describe("parseExpression reshape pipes", () => {
  it("compiles the base value and records reshape-unsupported", () => {
    const result = parse("revenue | asPoints(month, revenue)");
    expect(result.dropped).toBe(false);
    expect(result.value).toEqual({ $path: "/revenue" });
    expect(result.issues.map((issue) => issue.code)).toEqual(["reshape-unsupported"]);
    expect(result.issues[0]?.message).toMatch(/later wave/i);
  });

  it("consumes arbitrary text after the pipe without erroring", () => {
    const result = parse('5 | round | pad("x") ]] garbage');
    expect(result.dropped).toBe(false);
    expect(result.value).toBe(5);
    expect(result.issues.map((issue) => issue.code)).toEqual(["reshape-unsupported"]);
  });
});

describe("parseExpression malformed input", () => {
  it("drops unterminated strings", () => {
    expectDropped('"unterminated', "malformed-expression");
    expectDropped("'unterminated", "malformed-expression");
    expectDropped('"ends with escape\\', "malformed-expression");
  });

  it("drops unbalanced brackets", () => {
    expectDropped("[1, 2", "malformed-expression");
    expectDropped("{ a: 1", "malformed-expression");
    expectDropped("]", "malformed-expression");
    expectDropped("}", "malformed-expression");
    expectDropped("[1, 2]]", "malformed-expression");
  });

  it("drops trailing garbage after a complete value", () => {
    expectDropped("5 5", "malformed-expression");
    expectDropped("true false", "malformed-expression");
  });

  it("drops malformed object entries", () => {
    expectDropped("{ a }", "malformed-expression");
    expectDropped("{ : 1 }", "malformed-expression");
    expectDropped("{ 1: 2 }", "malformed-expression");
    expectDropped("{ a: }", "malformed-expression");
  });

  it("drops empty and whitespace-only sources", () => {
    expectDropped("", "malformed-expression");
    expectDropped("   ", "malformed-expression");
    expectDropped("\n\t", "malformed-expression");
  });

  it("drops stray commas and lone dots", () => {
    expectDropped(",", "malformed-expression");
    expectDropped(".", "malformed-expression");
    expectDropped("[,]", "malformed-expression");
  });
});

describe("parseExpression totality", () => {
  it("parses deep-but-reasonable nesting", () => {
    const depth = 200;
    const source = "[".repeat(depth) + "1" + "]".repeat(depth);
    const result = parse(source);
    expect(result.dropped).toBe(false);
  });

  it("never throws, on any input", () => {
    const nasty = [
      "",
      "   ",
      "[".repeat(200_000),
      "{".repeat(200_000),
      "\\".repeat(999),
      '"' + "\\".repeat(999),
      " ￿\uD800",
      "{ a: [ } ]",
      "state.",
      "|",
      "revenue |",
      "🚀",
      "[]".repeat(50_000),
    ];
    for (const source of nasty) {
      let result: ReturnType<typeof parseExpression> | undefined;
      expect(() => {
        result = parseExpression(source, context);
      }).not.toThrow();
      expect(typeof result?.dropped).toBe("boolean");
      expect(Array.isArray(result?.issues)).toBe(true);
    }
  });

  it("always returns an ordered issues array, empty when clean", () => {
    expect(parse("42").issues).toEqual([]);
    const piped = parse("mystery | reshape");
    expect(piped.dropped).toBe(true);
    expect(piped.issues[0]?.code).toBe("unknown-reference");
  });
});
