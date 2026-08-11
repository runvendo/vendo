import { describe, expect, it } from "vitest";
import { parseExpression, type ExpressionContext } from "../../../../src/contract/genui/wire/expression.js";

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

  it("drops 1e999 (overflows to Infinity, which canonicalJson rejects)", () => {
    expectDropped("1e999", "malformed-expression");
  });

  it("drops -1e999 (overflows to -Infinity, which canonicalJson rejects)", () => {
    expectDropped("-1e999", "malformed-expression");
  });

  it("accepts the number spellings JavaScript has and JSON does not", () => {
    // The grammar is a JavaScript expression, so JSON5-lite comes for free.
    expectValue("+5", 5);
    expectValue(".5", 0.5);
    expectValue("05", 5);
    expectValue("1.", 1);
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

  it("decodes \\uXXXX and \\r escapes", () => {
    expectValue('"Caf\\u00e9"', "Café");
    expectValue('"\\u0041"', "A");
    expectValue('"a\\rb"', "a\rb");
    expectValue('"\\uD83D\\uDE00"', "😀");
  });

  it("drops invalid \\u escapes", () => {
    expectDropped('"\\uZZZZ"', "malformed-expression");
    expectDropped('"\\u12"', "malformed-expression");
  });

  it("drops ill-formed UTF-16 (lone surrogates), literal or escaped", () => {
    expectDropped('"\uD800"', "malformed-expression");
    expectDropped('"\\uD800"', "malformed-expression");
    expectDropped('"a\uDC00b"', "malformed-expression");
  });

  it("accepts well-formed astral characters", () => {
    expectValue('"🚀"', "🚀");
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

  it("resolves duplicate object keys last-wins", () => {
    expectValue("{ a: 1, a: 2 }", { a: 2 });
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

  it("lists the declared queries in an unknown-reference issue, so a retry can pick one instead of guessing again", () => {
    const result = parse("mystery");
    expect(result.issues[0]?.message).toContain("revenue, payments");
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

  it("addresses an array element by subscript, and rejects the dot-numeric spelling", () => {
    // A fixed row reads by position (hosts expose number[] fields under array
    // rows, e.g. accounts.data[0].sparkline). The subscript is the ONE spelling:
    // `accounts.data.0` is not valid JavaScript, so the grammar cannot carry it.
    const numeric = parseExpression("revenue[0]", { queryNames: new Set(["revenue"]) });
    expect(numeric.issues).toEqual([]);
    expect(numeric.value).toEqual({ $path: "/revenue/0" });
    const midPath = parseExpression("accounts.data[0].sparkline", { queryNames: new Set(["accounts"]) });
    expect(midPath.issues).toEqual([]);
    expect(midPath.value).toEqual({ $path: "/accounts/data/0/sparkline" });
    expectDropped("revenue.0", "malformed-expression");
    expectDropped("revenue.", "malformed-expression");
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

  it("drops object entries JavaScript itself cannot parse", () => {
    expectDropped("{ : 1 }", "malformed-expression");
    expectDropped("{ a: }", "malformed-expression");
    // Shorthand and numeric keys are legal JavaScript, so they lower like any
    // other entry: the shorthand's value is a REFERENCE, resolved as one.
    expectValue("{ revenue }", { revenue: { $path: "/revenue" } });
    expectDropped("{ a }", "unknown-reference");
    expectValue("{ 1: 2 }", { 1: 2 });
  });

  it("drops empty and whitespace-only sources", () => {
    expectDropped("", "malformed-expression");
    expectDropped("   ", "malformed-expression");
    expectDropped("\n\t", "malformed-expression");
  });

  it("drops stray commas and lone dots", () => {
    expectDropped(",", "malformed-expression");
    expectDropped(".", "malformed-expression");
  });

  it("computes an array literal carrying a hole or a spread instead of lowering it element-wise", () => {
    expectValue("[,]", { $expr: "[,]" });
    expectValue("[1, ...revenue.rows]", { $expr: "[1, ...revenue.rows]" });
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
      "\0￿\uD800",
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

/**
 * Computed values — everything that is not a literal or a plain reference.
 *
 * There is no closed call vocabulary and no reshape dialect left: arrays,
 * objects, strings and numbers carry their own methods, so a gap that computes
 * becomes `{ $expr }` holding its source VERBATIM, and every name it reads from
 * outside itself must be a declared `<Query>`.
 */
describe("computed values ($expr)", () => {
  it("compiles anything that computes to { $expr }, at any depth", () => {
    expectValue("revenue.total / 100", { $expr: "revenue.total / 100" });
    expectValue("(revenue.total - 500) * 2", { $expr: "(revenue.total - 500) * 2" });
    expectValue("-revenue.total + 1", { $expr: "-revenue.total + 1" });
    // A bare subtraction is infix even with whitespace around the operator.
    expectValue("revenue.total - 500", { $expr: "revenue.total - 500" });
    const reduce = "revenue.rows.reduce((total, row) => total + row.amount_cents, 0)";
    expectValue(`${reduce} / payments.rows.length`, { $expr: `${reduce} / payments.rows.length` });
    expectValue("[revenue.rows.length, 5]", [{ $expr: "revenue.rows.length" }, 5]);
    expectValue(`{ total: ${reduce} }`, { total: { $expr: reduce } });
    expectValue('revenue.rows.filter((row) => row.status === "open")', {
      $expr: 'revenue.rows.filter((row) => row.status === "open")',
    });
    // An arrow function's own parameters are BOUND, so only `revenue` is read
    // from outside — `row` naming no query is not a finding.
    expectValue("revenue.rows.map((row) => ({ label: row.month }))", {
      $expr: "revenue.rows.map((row) => ({ label: row.month }))",
    });
  });

  it("keeps the source VERBATIM, interior spacing included, so the printer can re-emit it", () => {
    const spaced = "revenue.rows.reduce( (total , row) => total + row.amount , 0 )";
    expectValue(spaced, { $expr: spaced });
  });

  it("leaves every non-computed value on the binding/literal grammar", () => {
    expectValue("revenue.total", { $path: "/revenue/total" });
    expectValue("state.note", { $state: "note" });
    expectValue("-2", -2);
    expectValue("2.5E-2", 0.025);
    expectValue('"a / b"', "a / b");
    expectValue("[1, 2]", [1, 2]);
    expectValue("{ limit: 5 }", { limit: 5 });
    expectValue("{ note: 5 }", { note: 5 });
  });

  it("computes `length`, which a JSON Pointer walk could never reach", () => {
    expectValue("revenue.rows.length", { $expr: "revenue.rows.length" });
  });

  it("computes an intrinsic the sealed interpreter carries, rather than binding it as a path", () => {
    // `Math` is not query data, so `/Math/PI` would bind an empty value — and it
    // is not an unknown name either, because the VM really has it (expr.ts
    // SEALED_GLOBALS, which the fact check and the evaluator read too).
    expectValue("Math.PI", { $expr: "Math.PI" });
    expectValue("Math.max(revenue.rows.length, 0)", { $expr: "Math.max(revenue.rows.length, 0)" });
    // `Date` is DELETED by the seal, so it stays an unknown name.
    expectDropped("Date.now()", "unknown-reference");
  });

  it("drops a computed value whose expression does not parse or names no query", () => {
    expectDropped("revenue.total + * 2", "malformed-expression");
    expectDropped("ghost.rows.length / payments.rows.length", "unknown-reference");
    // The retired dialect's own names are now ordinary unknown references: the
    // scope is EXACTLY the declared queries, so nothing carries them.
    expectDropped('asPoints(revenue.rows, "month", "revenue")', "unknown-reference");
    expectDropped('sum(revenue.rows, "amount_cents")', "unknown-reference");
    expectDropped('group_by(payments.rows, "paid_at", "month", sum.of("amount"))', "unknown-reference");
    // `state` is not in the evaluator's scope either — a state value reaches a
    // prop as a binding, never through arithmetic.
    expectDropped("state.count + 1", "unknown-reference");
  });
});
