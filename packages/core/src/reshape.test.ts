import { describe, expect, it } from "vitest";
import {
  applyReshape,
  findDeprecatedReshapeUsage,
  findInvalidReshape,
  RESHAPE_MAX_STEPS,
  reshapeShape,
  type ReshapeStep,
} from "./reshape.js";
import type { ShapeType } from "./shape.js";

const step = (op: string, ...args: string[]): ReshapeStep => ({ op, args } as ReshapeStep);

const rows = [
  { month: "Jan", revenue: 1200, note: "promo" },
  { month: "Feb", revenue: 900 },
];

const rowsShape: ShapeType = {
  kind: "array",
  items: {
    kind: "object",
    fields: {
      month: { kind: "string" },
      revenue: { kind: "number" },
      note: { kind: "string" },
    },
    optional: ["note"],
  },
};

/** v2 spec §3 — the bounded, pure, non-Turing reshape vocabulary. */
describe("applyReshape", () => {
  it("undefined in ⇒ ok/undefined out (loading data is not a mismatch)", () => {
    expect(applyReshape(undefined, [step("pick", "month")])).toEqual({ ok: true, value: undefined });
  });

  it("no steps ⇒ identity", () => {
    expect(applyReshape(rows, [])).toEqual({ ok: true, value: rows });
  });

  it("pick keeps fields per-row on arrays and directly on objects", () => {
    expect(applyReshape(rows, [step("pick", "month", "revenue")])).toEqual({
      ok: true,
      value: [{ month: "Jan", revenue: 1200 }, { month: "Feb", revenue: 900 }],
    });
    expect(applyReshape({ a: 1, b: 2 }, [step("pick", "a")])).toEqual({ ok: true, value: { a: 1 } });
  });

  it("rename renames pairwise, tolerating rows without the field", () => {
    expect(applyReshape(rows, [step("rename", "month", "label")])).toEqual({
      ok: true,
      value: [
        { label: "Jan", revenue: 1200, note: "promo" },
        { label: "Feb", revenue: 900 },
      ],
    });
  });

  it("asPoints maps rows to { label, value } — the broken-chart fix", () => {
    expect(applyReshape(rows, [step("asPoints", "month", "revenue")])).toEqual({
      ok: true,
      value: [{ label: "Jan", value: 1200 }, { label: "Feb", value: 900 }],
    });
  });

  it("asOptions maps object rows to { value, label } — the blank-Select fix", () => {
    const accounts = [
      { id: "acc_1", name: "Checking", balance: 1200 },
      { id: "acc_2", name: "Savings" },
    ];
    expect(applyReshape(accounts, [step("asOptions", "id", "name")])).toEqual({
      ok: true,
      value: [
        { value: "acc_1", label: "Checking" },
        { value: "acc_2", label: "Savings" },
      ],
    });
  });

  it("asOptions is strict per-row: a row missing the value or label field is a mismatch", () => {
    const mixed = applyReshape(
      [{ id: "a", name: "A" }, { id: "b" }],
      [step("asOptions", "id", "name")],
    );
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.reason).toContain("name");
  });

  it("asPoints is strict per-row: a mixed-row response is a mismatch, never a silent partial chart", () => {
    const mixed = applyReshape(
      [{ month: "Jan", revenue: 1 }, { month: "Feb" }],
      [step("asPoints", "month", "revenue")],
    );
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.reason).toContain("revenue");
    // Sparse data carries explicit nulls; those rows still plot.
    expect(applyReshape(
      [{ month: "Jan", revenue: 1 }, { month: "Feb", revenue: null }],
      [step("asPoints", "month", "revenue")],
    )).toEqual({ ok: true, value: [{ label: "Jan", value: 1 }, { label: "Feb", value: null }] });
  });

  it("chains steps left to right", () => {
    expect(applyReshape(rows, [step("pick", "month", "revenue"), step("rename", "month", "label")])).toEqual({
      ok: true,
      value: [{ label: "Jan", revenue: 1200 }, { label: "Feb", revenue: 900 }],
    });
  });

  it("aggregates: sum/avg/min/max over a field, count over the array", () => {
    expect(applyReshape(rows, [step("sum", "revenue")])).toEqual({ ok: true, value: 2100 });
    expect(applyReshape(rows, [step("avg", "revenue")])).toEqual({ ok: true, value: 1050 });
    expect(applyReshape(rows, [step("min", "revenue")])).toEqual({ ok: true, value: 900 });
    expect(applyReshape(rows, [step("max", "revenue")])).toEqual({ ok: true, value: 1200 });
    expect(applyReshape(rows, [step("count")])).toEqual({ ok: true, value: 2 });
  });

  it("aggregates over an empty array: sum 0, count 0, avg/min/max null", () => {
    expect(applyReshape([], [step("sum", "x")])).toEqual({ ok: true, value: 0 });
    expect(applyReshape([], [step("count")])).toEqual({ ok: true, value: 0 });
    expect(applyReshape([], [step("avg", "x")])).toEqual({ ok: true, value: null });
  });

  it("format renders deterministic en-US strings (scalar and per-row forms)", () => {
    expect(applyReshape(0.42, [step("format", "percent")])).toEqual({ ok: true, value: "42%" });
    expect(applyReshape(1234.5, [step("format", "currency")])).toEqual({ ok: true, value: "$1,234.50" });
    expect(applyReshape(1234.5, [step("format", "number")])).toEqual({ ok: true, value: "1,234.5" });
    const formatted = applyReshape(rows, [step("format", "revenue", "currency")]);
    expect(formatted).toEqual({
      ok: true,
      value: [
        { month: "Jan", revenue: "$1,200.00", note: "promo" },
        { month: "Feb", revenue: "$900.00" },
      ],
    });
  });

  it("format currencyCents divides integer minor units by 100 (the raw-cents fix)", () => {
    expect(applyReshape(471711, [step("format", "currencyCents")]))
      .toEqual({ ok: true, value: "$4,717.11" });
    const perRow = applyReshape(
      [{ label: "housing", amount: 285000 }],
      [step("format", "amount", "currencyCents")],
    );
    expect(perRow).toEqual({ ok: true, value: [{ label: "housing", amount: "$2,850.00" }] });
  });

  it("format date accepts ISO strings and epoch numbers, UTC-stable", () => {
    expect(applyReshape("2026-07-18T12:00:00Z", [step("format", "date")]))
      .toEqual({ ok: true, value: "Jul 18, 2026" });
  });

  it("runtime mismatches are contained: ok false with a reason, never a throw", () => {
    const onScalar = applyReshape(42, [step("pick", "month")]);
    expect(onScalar.ok).toBe(false);
    const fieldAbsent = applyReshape(rows, [step("asPoints", "period", "revenue")]);
    expect(fieldAbsent.ok).toBe(false);
    if (!fieldAbsent.ok) expect(fieldAbsent.reason).toContain("period");
    const badAggregate = applyReshape([{ v: "x" }], [step("sum", "v")]);
    expect(badAggregate.ok).toBe(false);
    const badFormat = applyReshape("hello", [step("format", "currency")]);
    expect(badFormat.ok).toBe(false);
  });

  it("a field absent from every non-empty row is a mismatch; absent from some rows is not", () => {
    expect(applyReshape(rows, [step("rename", "period", "label")]).ok).toBe(false);
    expect(applyReshape(rows, [step("rename", "note", "label")]).ok).toBe(true);
  });
});

describe("reshapeShape (compile-time flow)", () => {
  it("flows a known shape through each op", () => {
    const picked = reshapeShape(rowsShape, step("pick", "month", "revenue"));
    expect(picked).toEqual({
      ok: true,
      shape: {
        kind: "array",
        items: {
          kind: "object",
          fields: { month: { kind: "string" }, revenue: { kind: "number" } },
        },
      },
    });
    const points = reshapeShape(rowsShape, step("asPoints", "month", "revenue"));
    expect(points).toEqual({
      ok: true,
      shape: {
        kind: "array",
        items: {
          kind: "object",
          fields: { label: { kind: "string" }, value: { kind: "number" } },
        },
      },
    });
    const options = reshapeShape(rowsShape, step("asOptions", "revenue", "month"));
    expect(options).toEqual({
      ok: true,
      shape: {
        kind: "array",
        items: {
          kind: "object",
          fields: { value: { kind: "number" }, label: { kind: "string" } },
        },
      },
    });
    const summed = reshapeShape(rowsShape, step("sum", "revenue"));
    expect(summed).toEqual({ ok: true, shape: { kind: "number" } });
    const renamed = reshapeShape(rowsShape, step("rename", "note", "hint"));
    if (!renamed.ok) throw new Error(renamed.error.message);
    expect(renamed.shape).toEqual({
      kind: "array",
      items: {
        kind: "object",
        fields: {
          month: { kind: "string" },
          revenue: { kind: "number" },
          hint: { kind: "string" },
        },
        optional: ["hint"],
      },
    });
  });

  it("format makes the formatted region a string", () => {
    const scalar = reshapeShape({ kind: "number" }, step("format", "currency"));
    expect(scalar).toEqual({ ok: true, shape: { kind: "string" } });
    const perRow = reshapeShape(rowsShape, step("format", "revenue", "currency"));
    if (!perRow.ok) throw new Error(perRow.error.message);
    expect(perRow.shape).toEqual({
      kind: "array",
      items: {
        kind: "object",
        fields: {
          month: { kind: "string" },
          revenue: { kind: "string" },
          note: { kind: "string" },
        },
        optional: ["note"],
      },
    });
  });

  it("json stays defensive: any step flows, aggregates still type as number", () => {
    expect(reshapeShape({ kind: "json" }, step("pick", "a"))).toEqual({ ok: true, shape: { kind: "json" } });
    expect(reshapeShape({ kind: "json" }, step("count"))).toEqual({ ok: true, shape: { kind: "number" } });
    expect(reshapeShape({ kind: "json" }, step("sum", "x"))).toEqual({ ok: true, shape: { kind: "number" } });
  });

  it("known-shape violations carry missing and available fields for repair", () => {
    const result = reshapeShape(rowsShape, step("asPoints", "period", "revenue"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.missing).toEqual(["period"]);
      expect(result.error.available).toEqual(["month", "revenue", "note"]);
    }
    expect(reshapeShape({ kind: "number" }, step("pick", "a")).ok).toBe(false);
    expect(reshapeShape(rowsShape, step("sum", "month")).ok).toBe(false);
    expect(reshapeShape({ kind: "string" }, step("format", "currency")).ok).toBe(false);
  });
});

describe("findInvalidReshape (the validateTreeV2 gate)", () => {
  it("accepts valid steps anywhere in a props record, and props without reshape", () => {
    expect(findInvalidReshape({
      points: { $path: "/revenue/rows", $reshape: [{ op: "asPoints", args: ["month", "revenue"] }] },
    })).toBeNull();
    expect(findInvalidReshape({ title: "x", nested: [{ deep: { $path: "/a" } }] })).toBeNull();
  });

  it("rejects unknown ops, bad arities, and non-string args, nested at any depth", () => {
    expect(findInvalidReshape({
      nested: [{ bad: { $path: "/a", $reshape: [{ op: "eval", args: [] }] } }],
    })).toContain("eval");
    expect(findInvalidReshape({
      p: { $path: "/a", $reshape: [{ op: "asPoints", args: ["only-one"] }] },
    })).not.toBeNull();
    expect(findInvalidReshape({
      p: { $path: "/a", $reshape: [{ op: "rename", args: ["odd", "pair", "extra"] }] },
    })).not.toBeNull();
    expect(findInvalidReshape({
      p: { $path: "/a", $reshape: [{ op: "pick", args: [1] }] },
    })).not.toBeNull();
    expect(findInvalidReshape({
      p: { $path: "/a", $reshape: [{ op: "format", args: ["x", "loud"] }] },
    })).not.toBeNull();
    expect(findInvalidReshape({ p: { $path: "/a", $reshape: "pick" } })).not.toBeNull();
  });

  it("caps the chain length (bounded, non-Turing)", () => {
    const steps = Array.from({ length: RESHAPE_MAX_STEPS + 1 }, () => ({ op: "count", args: [] }));
    expect(findInvalidReshape({ p: { $path: "/a", $reshape: steps } })).not.toBeNull();
    expect(findInvalidReshape({
      p: { $path: "/a", $reshape: steps.slice(0, RESHAPE_MAX_STEPS) },
    })).toBeNull();
  });
});

describe("reshapeShape defensive regions", () => {
  it("array-of-json regions pass every projection defensively", () => {
    const arrayJson: ShapeType = { kind: "array", items: { kind: "json" } };
    expect(reshapeShape(arrayJson, step("pick", "a"))).toEqual({ ok: true, shape: arrayJson });
    expect(reshapeShape(arrayJson, step("rename", "a", "b"))).toEqual({ ok: true, shape: arrayJson });
    expect(reshapeShape(arrayJson, step("format", "a", "currency"))).toEqual({ ok: true, shape: arrayJson });
    expect(reshapeShape(arrayJson, step("asPoints", "a", "b"))).toEqual({
      ok: true,
      shape: { kind: "array", items: { kind: "object", fields: { label: { kind: "json" }, value: { kind: "json" } } } },
    });
    expect(reshapeShape(arrayJson, step("sum", "a"))).toEqual({ ok: true, shape: { kind: "number" } });
  });

  it("bare-object pick/rename/format flow without an array wrapper", () => {
    const object: ShapeType = { kind: "object", fields: { a: { kind: "number" }, b: { kind: "string" } } };
    expect(reshapeShape(object, step("rename", "a", "x"))).toEqual({
      ok: true,
      shape: { kind: "object", fields: { x: { kind: "number" }, b: { kind: "string" } } },
    });
    expect(reshapeShape(object, step("format", "a", "currency"))).toEqual({
      ok: true,
      shape: { kind: "object", fields: { a: { kind: "string" }, b: { kind: "string" } } },
    });
    expect(reshapeShape(object, step("format", "b", "date"))).toEqual({
      ok: true,
      shape: { kind: "object", fields: { a: { kind: "number" }, b: { kind: "string" } } },
    });
  });

  it("structurally invalid steps report the structural violation", () => {
    expect(reshapeShape({ kind: "json" }, { op: "eval", args: [] } as never).ok).toBe(false);
  });
});

/** vendo-v2-cells — template: the bounded object→string projection for
 *  display slots (the raw-JSON-braces fix from the final 6-case gate). */
describe("template (object→string projection)", () => {
  const deadlines = [
    {
      client: "Blue Bottle Coffee",
      dueDate: "2026-07-21",
      progress: { received: 3, total: 6 },
      assignedTo: { id: "st_maya", name: "Maya Alvarez", role: "Account Manager" },
    },
    {
      client: "Verve Roasters",
      dueDate: "2026-07-24",
      progress: { received: 5, total: 5 },
      assignedTo: { id: "st_ali", name: "Ali Tran", role: "Bookkeeper" },
    },
  ];

  it("per-row form writes the target field from {path} placeholders (nested paths reach object fields)", () => {
    const result = applyReshape(deadlines, [step("template", "progress", "{progress.received} of {progress.total}")]);
    expect(result).toEqual({
      ok: true,
      value: [
        { ...deadlines[0], progress: "3 of 6" },
        { ...deadlines[1], progress: "5 of 5" },
      ],
    });
  });

  it("chained templates close both gate symptoms in one binding", () => {
    const result = applyReshape(deadlines, [
      step("template", "progress", "{progress.received} of {progress.total}"),
      step("template", "assignedTo", "{assignedTo.name}"),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { ...deadlines[0], progress: "3 of 6", assignedTo: "Maya Alvarez" },
        { ...deadlines[1], progress: "5 of 5", assignedTo: "Ali Tran" },
      ]);
    }
  });

  it("scalar form interpolates a bare object into one string", () => {
    expect(applyReshape({ name: "Blue Bottle Coffee", city: "Oakland" }, [step("template", "{name} — {city}")]))
      .toEqual({ ok: true, value: "Blue Bottle Coffee — Oakland" });
  });

  it("per-row form also applies directly to a bare object", () => {
    expect(applyReshape(
      { nearest: { name: "Blue Bottle Coffee" }, count: 12 },
      [step("template", "nearest", "{nearest.name}")],
    )).toEqual({ ok: true, value: { nearest: "Blue Bottle Coffee", count: 12 } });
  });

  it("null and per-row-absent placeholder values render empty; a non-scalar resolution is a mismatch", () => {
    expect(applyReshape(
      [{ a: null, b: 1 }, { b: 2 }],
      [step("template", "a", "[{a}]")],
    )).toEqual({ ok: true, value: [{ a: "[]", b: 1 }, { a: "[]", b: 2 }] });
    const nonScalar = applyReshape([{ a: { b: 1 } }], [step("template", "a", "{a}")]);
    expect(nonScalar.ok).toBe(false);
    if (!nonScalar.ok) expect(nonScalar.reason).toContain("{a}");
  });

  it("a placeholder root absent from every row is a mismatch (the mis-binding signal)", () => {
    const missing = applyReshape(deadlines, [step("template", "who", "{owner.name}")]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("owner");
  });

  it("scalar form on an array is a mismatch routing to the per-row form", () => {
    const wrong = applyReshape(deadlines, [step("template", "{client}")]);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toContain("template(field, pattern)");
  });

  it("patterns are validated against the closed grammar: at least one valid {field.path} placeholder", () => {
    expect(findInvalidReshape({ v: { $path: "/q/data", $reshape: [step("template", "a", "no placeholders")] } }))
      .toContain("placeholder");
    expect(findInvalidReshape({ v: { $path: "/q/data", $reshape: [step("template", "a", "{bad..path}")] } }))
      .not.toBeNull();
    expect(findInvalidReshape({ v: { $path: "/q/data", $reshape: [step("template", "a", "{ok.path} text")] } }))
      .toBeNull();
    expect(findInvalidReshape({ v: { $path: "/q/data", $reshape: [step("template")] } })).not.toBeNull();
    // A stray brace outside placeholders would re-render the exact raw-braces
    // output the op prevents — closed-grammar violation (cubic review).
    expect(findInvalidReshape({ v: { $path: "/q/data", $reshape: [step("template", "a", "{ok} of} total")] } }))
      .not.toBeNull();
    expect(findInvalidReshape({ v: { $path: "/q/data", $reshape: [step("template", "a", "{{ok}}")] } }))
      .not.toBeNull();
  });

  it("scalar form checks placeholder roots like the per-row form (no silent empty render)", () => {
    const missing = applyReshape({ city: "Oakland" }, [step("template", "{name}!")]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("name");
  });

  const deadlinesShape: ShapeType = {
    kind: "array",
    items: {
      kind: "object",
      fields: {
        client: { kind: "string" },
        dueDate: { kind: "string" },
        progress: { kind: "object", fields: { received: { kind: "number" }, total: { kind: "number" } } },
        assignedTo: { kind: "object", fields: { id: { kind: "string" }, name: { kind: "string" } } },
      },
    },
  };

  it("compile-time flow: the target field becomes a string per-row; scalar form strings an object", () => {
    const flowed = reshapeShape(deadlinesShape, step("template", "progress", "{progress.received} of {progress.total}"));
    expect(flowed.ok).toBe(true);
    if (flowed.ok && flowed.shape.kind === "array" && flowed.shape.items.kind === "object") {
      expect(flowed.shape.items.fields.progress).toEqual({ kind: "string" });
      expect(flowed.shape.items.fields.assignedTo?.kind).toBe("object");
    }
    expect(reshapeShape(
      { kind: "object", fields: { name: { kind: "string" } } },
      step("template", "{name}!"),
    )).toEqual({ ok: true, shape: { kind: "string" } });
  });

  it("compile-time violations: absent placeholder roots carry missing/available; non-scalar leaves flag", () => {
    const missing = reshapeShape(deadlinesShape, step("template", "who", "{owner.name}"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.missing).toEqual(["owner"]);
      expect(missing.error.available).toEqual(["client", "dueDate", "progress", "assignedTo"]);
    }
    const nonScalar = reshapeShape(deadlinesShape, step("template", "assignedTo", "{assignedTo}"));
    expect(nonScalar.ok).toBe(false);
    const scalarFormOnRows = reshapeShape(deadlinesShape, step("template", "{client}"));
    expect(scalarFormOnRows.ok).toBe(false);
  });

  it("json regions stay defensive through template", () => {
    expect(reshapeShape({ kind: "json" }, step("template", "{anything}"))).toEqual({ ok: true, shape: { kind: "string" } });
    const rowsForm = reshapeShape({ kind: "array", items: { kind: "json" } }, step("template", "a", "{a.b}"));
    expect(rowsForm.ok).toBe(true);
  });
});

/** W5a (v3 spec §Dialect retirement) — staged retirement mechanics. */
describe("findDeprecatedReshapeUsage", () => {
  it("flags asOptions, template, and format currencyCents — once per distinct kind", () => {
    const tree = {
      nodes: [
        { id: "select-1", component: "Select", props: { options: { $path: "/accounts/data", $reshape: [{ op: "asOptions", args: ["id", "name"] }] } } },
        { id: "table-1", component: "Table", props: { rows: { $path: "/deadlines/data", $reshape: [
          { op: "template", args: ["assignedTo", "{assignedTo.name}"] },
          { op: "format", args: ["amount", "currencyCents"] },
        ] } } },
        { id: "text-1", component: "Text", props: { value: { $path: "/x", $reshape: [{ op: "template", args: ["{a}"] }] } } },
      ],
    };
    const notices = findDeprecatedReshapeUsage(tree);
    expect(notices).toHaveLength(3);
    expect(notices.join("\n")).toContain('"asOptions"');
    expect(notices.join("\n")).toContain('"template"');
    expect(notices.join("\n")).toContain('"currencyCents"');
    expect(notices.join("\n")).toContain("labelField");
  });

  it("the taught path is clean: Kit-native props and live ops raise no notice", () => {
    expect(findDeprecatedReshapeUsage({
      nodes: [
        { id: "select-1", component: "Select", props: { options: { $path: "/accounts/data" }, labelField: "name", valueField: "id" } },
        { id: "stat-1", component: "Stat", props: { value: { $path: "/txns/data", $reshape: [{ op: "sum", args: ["amount"] }] } } },
        { id: "chart-1", component: "Chart", props: { points: { $path: "/rev/rows", $reshape: [{ op: "asPoints", args: ["month", "revenue"] }] } } },
        { id: "text-1", component: "Text", props: { value: { $path: "/d", $reshape: [{ op: "format", args: ["date"] }] } } },
      ],
    })).toEqual([]);
  });

  it("deprecated ops STAY COMPILING for stored apps (staged retirement, not deletion)", () => {
    expect(findInvalidReshape({ $reshape: [{ op: "asOptions", args: ["id", "name"] }] })).toBeNull();
    expect(findInvalidReshape({ $reshape: [{ op: "template", args: ["{name}"] }] })).toBeNull();
    expect(findInvalidReshape({ $reshape: [{ op: "format", args: ["currencyCents"] }] })).toBeNull();
    expect(applyReshape([{ id: "a", name: "Checking" }], [step("asOptions", "id", "name")]))
      .toEqual({ ok: true, value: [{ value: "a", label: "Checking" }] });
    expect(applyReshape(285000, [step("format", "currencyCents")])).toEqual({ ok: true, value: "$2,850.00" });
  });
});
