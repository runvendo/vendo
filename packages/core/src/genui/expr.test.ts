import { describe, expect, it } from "vitest";
import type { Json } from "../ids.js";
import type { ShapeType } from "../shape.js";
import {
  checkExpr,
  evaluateExpr,
  exprPathHeads,
  isExprBinding,
  parseExpr,
  type ExprCheckContext,
} from "./expr.js";

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

/** Fixed reference instant so `days_until` is deterministic. */
const now = Date.parse("2026-01-25T10:00:00.000Z");

const evaluate = (source: string, over: Record<string, Json> = data) =>
  evaluateExpr(source, over, { now });

const valueOf = (source: string, over: Record<string, Json> = data): Json | undefined => {
  const result = evaluate(source, over);
  if (!result.ok) throw new Error(`expected a value, got the issue: ${result.issue}`);
  return result.value;
};

const issueOf = (source: string, over: Record<string, Json> = data): string => {
  const result = evaluate(source, over);
  if (result.ok) throw new Error(`expected an issue, got the value: ${JSON.stringify(result.value)}`);
  return result.issue;
};

const invoicesShape: ShapeType = {
  kind: "array",
  items: {
    kind: "object",
    fields: {
      id: { kind: "string" },
      client_name: { kind: "string" },
      amount_cents: { kind: "number" },
      due_date: { kind: "string" },
    },
  },
};

const clientsShape: ShapeType = {
  kind: "array",
  items: { kind: "object", fields: { id: { kind: "string" }, name: { kind: "string" } } },
};

/** A REST-envelope tool: rows sit under "data", the top-level object's only
 *  other field is "total" — the shape TOOL RESPONSE SHAPES already teaches. */
const accountsShape: ShapeType = {
  kind: "object",
  fields: {
    data: { kind: "array", items: { kind: "object", fields: { id: { kind: "string" }, balance: { kind: "number" } } } },
    total: { kind: "number" },
  },
};

const shapes: Record<string, ShapeType> = {
  invoices: invoicesShape,
  clients: clientsShape,
  metrics: { kind: "object", fields: { total_cents: { kind: "number" }, label: { kind: "string" } } },
  logs: { kind: "array", items: { kind: "json" } },
  accounts: accountsShape,
};

const context: ExprCheckContext = {
  queryNames: ["invoices", "clients", "metrics", "unsampled", "logs", "accounts"],
  shapeOf: (name) => shapes[name],
};

describe("evaluateExpr", () => {
  it("arithmetic over aggregates evaluates against sample rows", () => {
    expect(valueOf('sum(invoices, "amount_cents") / count(clients)')).toBe(12_500);
    expect(valueOf('sum(invoices, "amount_cents")')).toBe(25_000);
    expect(valueOf("count(invoices)")).toBe(3);
    expect(valueOf('(sum(invoices, "amount_cents") - 5000) * 2')).toBe(40_000);
    expect(valueOf("metrics.total_cents / 100")).toBe(250);
    expect(valueOf('-sum(invoices, "amount_cents") + 25000')).toBe(0);
  });

  it("parse error reported as a sentence with the bad token", () => {
    const issue = issueOf('sum(invoices, "amount_cents") + * 2');
    expect(issue).toContain('"*"');
    expect(issue).toMatch(/^[a-z"(].* /);
    expect(issueOf('sum(invoices, "amount_cents"')).toContain(")");
    expect(issueOf("total(invoices.amount_cents)")).toContain("total");
    expect(issueOf('sum(invoices, "amount_cents") +')).toContain("ends");
    expect(issueOf('sum(invoices, "amount_cents") # 2')).toContain('"#"');
    expect(issueOf('group_by(invoices, "due_date", "month')).toContain("unterminated");
    expect(issueOf('sum(invoices, "amount_cents", clients)')).toContain("two arguments");
    expect(issueOf("difference(invoices.amount_cents)")).toContain("two arguments");
    expect(issueOf("count()")).toContain("one argument");
    expect(issueOf("(1 + 2")).toContain('")"');
    expect(issueOf("1 2")).toContain("trails");
  });

  it("reports a group_by written with the wrong argument kinds", () => {
    expect(issueOf('group_by(5, "due_date", "month", sum.of("amount_cents"))')).toContain("rows you name");
    expect(issueOf('group_by(invoices, "due_date", "month", days_until(invoices.due_date))')).toContain("aggregates");
    expect(issueOf('group_by(invoices, due_date, "month", sum.of("amount_cents"))')).toContain("quoted second argument");
  });

  it("unknown field reported naming the real fields", () => {
    const issue = issueOf('sum(invoices, "amont_cents")');
    expect(issue).toContain("amont_cents");
    expect(issue).toContain("amount_cents");
    expect(issue).toContain("client_name");
    expect(issueOf("metrics.totl_cents / 100")).toContain("total_cents");
  });

  it("sum over a string field reported as a type mismatch", () => {
    const issue = issueOf('sum(invoices, "client_name")');
    expect(issue).toContain("sum()");
    expect(issue).toContain("numeric");
    expect(issue).toContain("Acme");
  });

  it("days_until on a date field", () => {
    expect(valueOf("days_until(metrics.due)", { metrics: { due: "2026-02-01" } })).toBe(7);
    expect(valueOf("days_until(metrics.due)", { metrics: { due: "2026-01-20T23:00:00Z" } })).toBe(-5);
    expect(valueOf("days_until(metrics.due) * 24", { metrics: { due: "2026-01-27" } })).toBe(48);
    expect(issueOf("days_until(metrics.label)")).toContain("ISO date");
    expect(issueOf("days_until(metrics.total_cents)")).toContain("ISO date");
    expect(issueOf("days_until(invoices.due_date)")).toContain("one date");
  });

  it("group_by monthly bucketing", () => {
    expect(valueOf('group_by(invoices, "due_date", "month", sum.of("amount_cents"))')).toEqual([
      { key: "2026-01", value: 20_000 },
      { key: "2026-02", value: 5_000 },
    ]);
    expect(valueOf('group_by(invoices, "due_date", "month", count.of())')).toEqual([
      { key: "2026-01", value: 2 },
      { key: "2026-02", value: 1 },
    ]);
    expect(valueOf('group_by(invoices, "due_date", "day", max.of("amount_cents"))')).toEqual([
      { key: "2026-01-14", value: 12_000 },
      { key: "2026-01-28", value: 8_000 },
      { key: "2026-02-03", value: 5_000 },
    ]);
    expect(valueOf('group_by(invoices, "due_date", "year", average.of("amount_cents"))')).toEqual([
      { key: "2026", value: 25_000 / 3 },
    ]);
    expect(valueOf('group_by(empty, "due_date", "month", sum.of("amount_cents"))')).toEqual([]);
  });

  it("reports the group_by shapes it cannot bucket", () => {
    expect(issueOf('group_by(invoices, "due_date", "week", sum.of("amount_cents"))')).toContain("month");
    expect(issueOf('group_by(invoices, "client_name", "month", sum.of("amount_cents"))')).toContain("date");
    expect(issueOf('group_by(metrics.label, "due_date", "month", sum.of("total_cents"))')).toContain("list of rows");
    expect(issueOf('group_by(invoices, "due_date", "month", sum.of("balance"))')).toContain("balance");
    expect(issueOf('group_by(invoices, "amount_cents", "month", sum.of("amount_cents"))')).toContain("date");
    expect(issueOf('group_by(loose, "due_date", "month", sum.of("cents"))', { loose: [1, 2] })).toContain("list of rows");
    const mixed: Record<string, Json> = { mixed: [{ due_date: "2026-01-01", cents: 1 }, { cents: 2 }] };
    expect(issueOf('group_by(mixed, "due_date", "month", sum.of("cents"))', mixed)).toContain("due_date");
  });

  it("division by zero safe", () => {
    const result = evaluate('sum(invoices, "amount_cents") / count(empty)');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issue).toContain("zero");
    expect(issueOf('sum(invoices, "amount_cents") / 0')).toContain("zero");
    expect(issueOf('average(empty, "amount_cents")')).toContain("average()");
    expect(issueOf('min(empty, "amount_cents")')).toContain("min()");
  });

  it("treats data that has not arrived as loading, never as a problem", () => {
    expect(valueOf('sum(invoices, "amount_cents") / count(clients)', {})).toBeUndefined();
    expect(valueOf('sum(invoices, "amount_cents") + 1', { clients: [] })).toBeUndefined();
    expect(valueOf("count(invoices)", { invoices: null })).toBeUndefined();
    expect(valueOf("days_until(metrics.due)", { metrics: { due: null } })).toBeUndefined();
    expect(valueOf('group_by(invoices, "due_date", "month", sum.of("amount_cents"))', {})).toBeUndefined();
    expect(valueOf("-invoices", { invoices: null })).toBeUndefined();
  });

  it("says which value is not a number instead of computing with it", () => {
    expect(issueOf("metrics.label / 2")).toContain("not a number");
    expect(issueOf("invoices / 2")).toContain("reduce it");
    expect(issueOf("-metrics.label")).toContain("not a number");
    expect(issueOf("count(metrics)")).toContain("count()");
    expect(issueOf("count(metrics.label)")).toContain("count()");
    expect(issueOf("difference(metrics.total_cents, metrics.label)")).toContain("not a number");
    expect(valueOf("difference(metrics.total_cents, 5000)")).toBe(20_000);
  });

  it("reads columns out of rows and past nested objects", () => {
    const nested: Record<string, Json> = {
      orders: [
        { lines: [{ cents: 100 }, { cents: 200 }] },
        { lines: [{ cents: 300 }] },
      ],
      wrapped: { rows: [{ cents: 5 }, { cents: 6 }] },
    };
    expect(valueOf('sum(orders, "lines.cents")', nested)).toBe(600);
    expect(valueOf('sum(wrapped.rows, "cents")', nested)).toBe(11);
    expect(valueOf("count(wrapped.rows)", nested)).toBe(2);
    expect(valueOf('sum(orders.0, "lines.cents")', nested)).toBe(300);
    expect(issueOf('sum(orders, "lines.total")', nested)).toContain("cents");
    expect(issueOf('sum(wrapped.rows, "cents.deeper")', nested)).toContain("reads past");
    expect(issueOf("count(orders.lines)", { orders: [1, 2] })).toContain("rows");
  });

  it("is total on pathological input", () => {
    const deep = `${"(".repeat(200)}1${")".repeat(200)}`;
    expect(issueOf(deep)).toContain("nested");
    expect(issueOf("")).toContain("ends");
    expect(issueOf("1e999")).toContain("too large");
    expect(issueOf("invoices.")).toContain('"."');
  });
});

describe("parseExpr", () => {
  it("parses numbers, strings, paths, and precedence", () => {
    expect(parseExpr("1 + 2 * 3").ok).toBe(true);
    const parsed = parseExpr('sum(a, "b") / count(c)');
    expect(parsed.ok && parsed.node.kind).toBe("binary");
    expect(parsed.ok && exprPathHeads(parsed.node)).toEqual(["a", "c"]);
    expect(exprPathHeads({ kind: "number", value: 1 })).toEqual([]);
  });

  it("recognises an $expr binding object", () => {
    expect(isExprBinding({ $expr: "count(a)" })).toBe(true);
    expect(isExprBinding({ $path: "/a" })).toBe(false);
    expect(isExprBinding(null)).toBe(false);
    expect(isExprBinding({ $expr: 3 })).toBe(false);
  });
});

describe("checkExpr", () => {
  it("passes an expression whose fields and types all check out", () => {
    expect(checkExpr('sum(invoices, "amount_cents") / count(clients)', context)).toEqual([]);
    expect(checkExpr('group_by(invoices, "due_date", "month", sum.of("amount_cents"))', context)).toEqual([]);
    expect(checkExpr('group_by(invoices, "due_date", "month", count.of())', context)).toEqual([]);
    expect(checkExpr("days_until(invoices.0.due_date) * 2", context)).toEqual([]);
    expect(checkExpr("metrics.total_cents - 1", context)).toEqual([]);
    // No shape card for the query, or an unknown region inside one: unknown
    // regions stay silent (defensive).
    expect(checkExpr('sum(unsampled, "whatever")', context)).toEqual([]);
    expect(checkExpr('sum(logs, "cents")', context)).toEqual([]);
  });

  it("reports a parse error as the expression's one issue", () => {
    expect(checkExpr('sum(invoices, "amount_cents") + * 2', context)).toEqual([expect.stringContaining('"*"')]);
  });

  it("unknown field reported naming the real fields", () => {
    const [issue, ...rest] = checkExpr('sum(invoices, "amont_cents")', context);
    expect(rest).toEqual([]);
    expect(issue).toContain("amont_cents");
    expect(issue).toContain("amount_cents");
    expect(issue).toContain("client_name");
    expect(checkExpr("count(nope.rows)", context)).toEqual([
      expect.stringContaining("does not name a declared query"),
    ]);
    expect(checkExpr("metrics.totl_cents", context)).toEqual([expect.stringContaining("total_cents")]);
    expect(checkExpr("metrics.total_cents.deeper", context)).toEqual([expect.stringContaining("reads past")]);
    expect(checkExpr('sum(invoices, "amount_cents.deeper")', context)).toEqual([
      expect.stringContaining("reads past"),
    ]);
  });

  it("sum over a string field reported as a type mismatch", () => {
    const [issue] = checkExpr('sum(invoices, "client_name")', context);
    expect(issue).toContain("sum()");
    expect(issue).toContain("client_name");
    expect(issue).toContain("string");
    expect(issue).toContain("amount_cents");
  });

  it("hints the .data envelope when the field really lives one level down", () => {
    const [issue] = checkExpr('sum(accounts, "balance")', context);
    expect(issue).toContain("balance");
    expect(issue).toContain("accounts.data.balance");
    expect(issue).toContain('"data" field');
  });

  it("reports every other slot whose type cannot compute", () => {
    expect(checkExpr("count(metrics.label)", context)).toEqual([expect.stringContaining("count()")]);
    expect(checkExpr("count(metrics)", context)).toEqual([expect.stringContaining("count()")]);
    expect(checkExpr("days_until(invoices.amount_cents)", context)).toEqual([
      expect.stringContaining("days_until()"),
    ]);
    expect(checkExpr("metrics.label / 2", context)).toEqual([expect.stringContaining("not a number")]);
    expect(checkExpr("-metrics.label", context)).toEqual([expect.stringContaining("not a number")]);
    expect(checkExpr("invoices / 2", context)).toEqual([expect.stringContaining("reduce it")]);
    expect(checkExpr('group_by(invoices, "amount_cents", "month", sum.of("amount_cents"))', context)).toEqual([
      expect.stringContaining("date"),
    ]);
    expect(checkExpr('difference(invoices.client_name, "x")', context).length).toBeGreaterThan(0);
    // Rows with no numeric field at all: the finding still names the offender,
    // it just has no numeric field to suggest.
    expect(checkExpr('sum(clients, "name")', context)).toEqual([expect.stringContaining("sum()")]);
    expect(checkExpr('"x" / 2', context)).toEqual([expect.stringContaining("not a number")]);
    expect(checkExpr('group_by(invoices, "due_date", "month", sum.of("amount_cents")) / 2', context)).toEqual([
      expect.stringContaining("reduce it"),
    ]);
  });
});
