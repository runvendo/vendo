import { beforeAll, describe, expect, it } from "vitest";
import { type Json } from "@vendoai/core";
import {
  checkExpr,
  EXPR_MAX_CHARS,
  evaluateExpr,
  exprFreeIdentifiers,
  isExprBinding,
  parseExpr,
  warmExprRuntime,
  type ExprCheckContext,
} from "../../../src/contract/genui/expr.js";

const data: Record<string, Json> = {
  invoices: [
    { id: "i1", client_name: "Acme", amount_cents: 12_000, due_date: "2026-01-14" },
    { id: "i2", client_name: "Globex", amount_cents: 8_000, due_date: "2026-01-28" },
    { id: "i3", client_name: "Initech", amount_cents: 5_000, due_date: "2026-02-03" },
  ],
  clients: [{ id: "c1", name: "Acme" }, { id: "c2", name: "Globex" }],
  empty: [],
  metrics: { total_cents: 25_000, label: "all invoices" },
};

const TOTAL = "invoices.reduce((total, row) => total + row.amount_cents, 0)";

const valueOf = (source: string, over: Record<string, Json> = data): Json | undefined => {
  const result = evaluateExpr(source, over);
  if (!result.ok) throw new Error(`expected a value, got the issue: ${result.issue}`);
  return result.value;
};

const issueOf = (source: string, over: Record<string, Json> = data): string => {
  const result = evaluateExpr(source, over);
  if (result.ok) throw new Error(`expected an issue, got the value: ${JSON.stringify(result.value)}`);
  return result.issue;
};

const context: ExprCheckContext = { queryNames: ["invoices", "clients", "empty", "metrics"] };

/** Evaluation is synchronous, but the WebAssembly interpreter behind it loads
 *  once, asynchronously — so a caller that must not miss the first render awaits
 *  the boot. Unwarmed, every expression reads as loading. */
beforeAll(async () => {
  await warmExprRuntime();
});

describe("parseExpr", () => {
  it("parses a JavaScript expression and records where it stopped", () => {
    const parsed = parseExpr("1 + 2 * 3");
    expect(parsed.ok && parsed.node.type).toBe("BinaryExpression");
    // `node.end` is how the wire compiler finds trailing content: the parse
    // itself succeeds on the leading expression alone.
    const trailing = parseExpr("1 2");
    expect(trailing.ok && trailing.node.end).toBe(1);
  });

  it("reports input that is not a JavaScript expression as one sentence", () => {
    for (const source of ["", "*", "1 +", "invoices."]) {
      const parsed = parseExpr(source);
      expect(parsed.ok).toBe(false);
      const issue = parsed.ok ? "" : parsed.issue;
      expect(issue).toContain("this expression is not valid JavaScript:");
      // An attribute is one fragment with no lines of its own, so acorn's
      // `(line:column)` suffix is stripped.
      expect(issue).not.toMatch(/\(\d+:\d+\)$/u);
    }
  });

  it("caps the source length, and says where the work belongs instead", () => {
    expect(EXPR_MAX_CHARS).toBe(1_000);
    const long = `"${"x".repeat(EXPR_MAX_CHARS)}"`;
    const parsed = parseExpr(long);
    expect(parsed.ok).toBe(false);
    const issue = parsed.ok ? "" : parsed.issue;
    expect(issue).toContain(`${long.length} characters`);
    expect(issue).toContain(`at most ${EXPR_MAX_CHARS}`);
    expect(issue).toContain("<Island>");
    // One character under the cap still parses.
    expect(parseExpr(`"${"x".repeat(EXPR_MAX_CHARS - 2)}"`).ok).toBe(true);
  });
});

describe("exprFreeIdentifiers", () => {
  const freeIn = (source: string): string[] => {
    const parsed = parseExpr(source);
    if (!parsed.ok) throw new Error(`could not parse: ${parsed.issue}`);
    return exprFreeIdentifiers(parsed.node);
  };

  it("reads the names an expression takes from OUTSIDE itself, in order, once each", () => {
    expect(freeIn("a.b + c")).toEqual(["a", "c"]);
    expect(freeIn("a + b + a")).toEqual(["a", "b"]);
  });

  it("skips field names — a non-computed property or key names a field, not a value", () => {
    expect(freeIn("rows.length")).toEqual(["rows"]);
    expect(freeIn("({ label: rows.n })")).toEqual(["rows"]);
    // …and walks the computed ones, which DO name values.
    expect(freeIn("rows[idx]")).toEqual(["rows", "idx"]);
    expect(freeIn("({ [key]: rows.n })")).toEqual(["key", "rows"]);
  });

  it("binds an arrow function's parameters, destructured ones included", () => {
    expect(freeIn("rows.reduce((total, row) => total + row.n, 0)")).toEqual(["rows"]);
    expect(freeIn("rows.map(({ a, b }) => a + b)")).toEqual(["rows"]);
  });
});

describe("evaluateExpr", () => {
  it("is real JavaScript over the resolved query data", () => {
    expect(valueOf(TOTAL)).toBe(25_000);
    expect(valueOf(`${TOTAL} / clients.length`)).toBe(12_500);
    expect(valueOf("metrics.total_cents / 100")).toBe(250);
    expect(valueOf("invoices.length")).toBe(3);
    expect(valueOf("empty.length")).toBe(0);
    expect(valueOf("invoices[0].due_date")).toBe("2026-01-14");
    expect(valueOf('invoices.map((row) => row.client_name).join(", ")')).toBe("Acme, Globex, Initech");
    expect(valueOf('invoices.filter((row) => row.amount_cents > 6_000).length')).toBe(2);
    expect(valueOf("`${metrics.label}: ${metrics.total_cents}`")).toBe("all invoices: 25000");
    expect(valueOf('metrics.total_cents > 0 ? "yes" : "no"')).toBe("yes");
    expect(valueOf("metrics.label.toUpperCase()")).toBe("ALL INVOICES");
    expect(valueOf("invoices.map((row) => row.amount_cents).sort((a, b) => a - b)[0]")).toBe(5_000);
  });

  it("treats data that has not arrived as loading, never as a problem", () => {
    expect(valueOf(TOTAL, {})).toBeUndefined();
    expect(valueOf(`${TOTAL} / clients.length`, { clients: [] })).toBeUndefined();
  });

  it("reads a query that answered NULL as loading too — either operand still loading is loading", () => {
    // A tool may legitimately answer `null`, and the key is then present with a
    // null value. The old dialect read that as loading, and this one says it
    // gives "the same answer the old dialect gave" (expr.ts, evaluateExpr).
    expect(valueOf("invoices.length", { invoices: null })).toBeUndefined();
  });

  it("reads an absent FIELD of arrived data as undefined, and refuses to read through one", () => {
    expect(valueOf("metrics.missing")).toBeUndefined();
    expect(valueOf("metrics?.missing?.deeper")).toBeUndefined();
    expect(issueOf("metrics.missing.deeper")).toContain("this expression threw TypeError");
  });

  it("an evaluation problem is the issue the renderer shows, never a throw", () => {
    expect(issueOf("invoices.nope()")).toContain("this expression threw TypeError");
    expect(issueOf("metrics.total_cents +")).toContain("this expression is not valid JavaScript");
    expect(issueOf(`"${"x".repeat(EXPR_MAX_CHARS)}"`)).toContain("<Island>");
  });

  it("has no spelling for a non-finite result, so one arrives as null", () => {
    expect(valueOf("metrics.total_cents / 0")).toBeNull();
    expect(valueOf("metrics.total_cents * metrics.missing")).toBeNull();
  });

  it("is deterministic: the same source over the same data is the same answer", () => {
    expect(valueOf(TOTAL)).toBe(valueOf(TOTAL));
    expect(valueOf('invoices.map((row) => row.id).join("|")'))
      .toBe(valueOf('invoices.map((row) => row.id).join("|")'));
  });

  it("scopes an expression to EXACTLY the query data — no state, no tools", () => {
    expect(valueOf("state.tab")).toBeUndefined();
    expect(valueOf("tools.invoices")).toBeUndefined();
  });

  it("answers every data identity from its own data, however many alternate", () => {
    // One interpreter context per `data` identity, disposed when the identity
    // moves on — so a second app's numbers can never be served from the first's.
    const one: Record<string, Json> = { metrics: { total_cents: 1 } };
    const two: Record<string, Json> = { metrics: { total_cents: 2 } };
    expect(valueOf("metrics.total_cents", one)).toBe(1);
    expect(valueOf("metrics.total_cents", two)).toBe(2);
    expect(valueOf("metrics.total_cents", one)).toBe(1);
  });

  it("ignores a data key that could not be an identifier, instead of failing on it", () => {
    // The names are marshalled in as a destructuring parameter list, so a key
    // the expression grammar could not have named must not reach it.
    const withOddKeys = { ...data, "a-b": 1, "9x": 2 } as Record<string, Json>;
    expect(valueOf(TOTAL, withOddKeys)).toBe(25_000);
  });
});

describe("checkExpr", () => {
  it("passes an expression whose every name is a declared query", () => {
    expect(checkExpr(TOTAL, context)).toEqual([]);
    expect(checkExpr(`${TOTAL} / clients.length`, context)).toEqual([]);
    expect(checkExpr("metrics.total_cents - 1", context)).toEqual([]);
    expect(checkExpr('invoices.map((row) => ({ label: row.client_name }))', context)).toEqual([]);
    expect(checkExpr('metrics.total_cents > 0 ? "yes" : "no"', context)).toEqual([]);
  });

  it("reports a parse error as the expression's one issue", () => {
    expect(checkExpr("metrics.total_cents + * 2", context))
      .toEqual([expect.stringContaining("this expression is not valid JavaScript")]);
  });

  it("reports every name that is not a declared query, and lists the queries", () => {
    const [issue, ...rest] = checkExpr("ghost.rows.length", context);
    expect(rest).toEqual([]);
    expect(issue).toContain('"ghost" does not name a declared query');
    expect(issue).toContain("invoices, clients, empty, metrics");
    expect(checkExpr("ghost.a + phantom.b", context)).toEqual([
      expect.stringContaining('"ghost"'),
      expect.stringContaining('"phantom"'),
    ]);
    expect(checkExpr("ghost", { queryNames: [] }))
      .toEqual([expect.stringContaining("(none declared)")]);
  });

  it("leaves FIELDS and TYPES to the compiler — one type checker, not two", () => {
    // A misspelled field is a `tsc` error over the printed screen naming the real
    // fields (checking/screen-typings.ts); a bespoke shape walker here could only
    // disagree with it.
    expect(checkExpr("invoices.reduce((total, row) => total + row.amont_cents, 0)", context)).toEqual([]);
    expect(checkExpr("metrics.totl_cents / 100", context)).toEqual([]);
    expect(checkExpr('invoices.reduce((total, row) => total + row.client_name, "")', context)).toEqual([]);
  });
});

describe("isExprBinding", () => {
  it("recognises an $expr binding object", () => {
    expect(isExprBinding({ $expr: "invoices.length" })).toBe(true);
    expect(isExprBinding({ $path: "/a" })).toBe(false);
    expect(isExprBinding(null)).toBe(false);
    expect(isExprBinding({ $expr: 3 })).toBe(false);
  });
});
