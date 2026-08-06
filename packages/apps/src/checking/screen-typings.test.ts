/**
 * The generator's contract: deterministic declaration text, derived from the
 * schemas the system already has, never a hand-written list.
 */
import {
  EXPR_BUCKETS,
  EXPR_CALLS,
  KIT_WIRE_COMPONENT_NAMES,
  WIRE_COMPONENT_NAMES,
  type JsonSchema,
  type NormalizedCatalog,
  type ShapeType,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { AGGREGATE_FIELD_ARITY, screenTypings } from "./screen-typings.js";

const netWorthSchema: JsonSchema = {
  type: "object",
  properties: {
    valueCents: { type: "number", description: "Total balance in integer cents" },
    series: { type: "array", items: { type: "number" } },
    label: { type: "string" },
  },
  required: ["valueCents", "series"],
  additionalProperties: false,
};

const catalog: NormalizedCatalog = [
  { name: "MapleNetWorthCard", description: "Net worth", propsJsonSchema: netWorthSchema },
  { name: "MapleFreeform", description: "No schema at all" },
];

const invoicesShape: ShapeType = {
  kind: "object",
  fields: {
    data: {
      kind: "array",
      items: { kind: "object", fields: { id: { kind: "string" }, amount_cents: { kind: "number" } } },
    },
    total: { kind: "number" },
  },
};

describe("screenTypings", () => {
  it("declares every wire component name as a JSX value", () => {
    const dts = screenTypings({ catalog: [], queries: [] });
    for (const name of WIRE_COMPONENT_NAMES) {
      expect(dts, `${name} must be declared`).toContain(`declare const ${name}:`);
    }
  });

  it("carries the Kit's zod prop types, not just its prop names", () => {
    const dts = screenTypings({ catalog: [], queries: [] });
    // Money.cents is a REQUIRED number (data class); currency an optional string.
    // Every prop also admits VendoBinding — see the unresolvable-binding test below.
    expect(dts).toContain("declare const Money: (props: { cents: number | VendoBinding; currency?: string | VendoBinding;");
    // Stat.format is an enum — the literal union is what makes format=\"huge\" a type error.
    expect(dts).toContain('format?: "money" | "date" | "datetime" | "time" | "percent" | "number" | "text"');
  });

  /**
   * A binding `printWire` cannot spell as a dotted reference — a numeric-index
   * path, a stored aggregate reshape — prints as a quoted `{"$path":…}` object
   * literal. tsc cannot walk one, so it carries no type information and must not
   * be a finding: the renderer resolves the real value.
   *
   * Regression 2026-08-06 (the origin/main merge): the legacy prewired components'
   * `any` props used to absorb these literals. V4 retired that family, so
   * `<Text text={{$path:"/results/records/0/data/summary"}}/>` — a real stored
   * screen, proven end to end by vendo's `ladder.e2e.test.ts` — started failing
   * the floor against `Text.text: string | number` and painted nothing.
   */
  it("admits an unresolvable binding literal in any typed prop slot", () => {
    const dts = screenTypings({ catalog, queries: [] });
    expect(dts).toContain("declare type VendoBinding = { $path: string } | { $state: string } | { $expr: string };");
    // The exact slot the regression hit — Text.text, a REQUIRED string | number,
    // which is where a missing-prop error anchors on the tag rather than the
    // attribute (so no checker-side suppression could have caught every spelling).
    expect(dts).toContain("text: string | number | VendoBinding");
    // An enum slot keeps its literal union — format="huge" is still a type error.
    expect(dts).toContain('format?: "money" | "date" | "datetime" | "time" | "percent" | "number" | "text" | VendoBinding');
  });

  it("types host components from their derived JSON Schema", () => {
    const dts = screenTypings({ catalog, queries: [] });
    expect(dts).toContain("declare const MapleNetWorthCard: (props: { valueCents: number; series: Array<number>; label?: string;");
  });

  it("gives a schema-less catalog entry a permissive type (01 §14)", () => {
    const dts = screenTypings({ catalog, queries: [] });
    expect(dts).toContain("declare const MapleFreeform: (props: { [prop: string]: any");
  });

  it("lets a Kit name win over a host component of the same name", () => {
    const dts = screenTypings({
      catalog: [{ name: "Stack", description: "a host component squatting a built-in name" }],
      queries: [],
    });
    expect(dts.match(/declare const Stack:/gu)).toHaveLength(1);
    // The renderer resolves a built-in name before it looks at the catalog, so
    // the Kit spec's typed props are what a screen may write.
    expect(dts).toContain("declare const Stack: (props: { gap?: number | VendoBinding;");
  });

  /** V4 — the legacy prewired family is retired, so DataTable is the only
   *  table and it carries a real zod-derived type, not a permissive name set. */
  it("types the one table from its Kit spec, not a permissive name list", () => {
    const dts = screenTypings({ catalog: [], queries: [] });
    expect(dts).toContain("declare const DataTable: (props: { rows:");
    expect(dts).not.toContain("declare const Table:");
  });

  it("allows `pending` on every component (the plan skeleton writes it on every leaf)", () => {
    const dts = screenTypings({ catalog, queries: [] });
    for (const declaration of dts.split("\n").filter((line) => line.startsWith("declare const "))) {
      if (!declaration.includes("(props:")) continue;
      expect(declaration, declaration).toContain("pending?: any");
    }
  });

  it("declares each query NAME as its result type, from the declared outputSchema", () => {
    const dts = screenTypings({
      catalog: [],
      queries: [{ name: "invoices", tool: "maple_invoices_list" }],
      toolOutputSchemas: {
        maple_invoices_list: {
          type: "object",
          properties: { data: { type: "array", items: { type: "object", properties: { amount_cents: { type: "number" } }, required: ["amount_cents"] } } },
          required: ["data"],
          additionalProperties: false,
        },
      },
    });
    expect(dts).toContain("declare const invoices: { data: Array<{ amount_cents: number }> }");
  });

  it("falls back to the observed ShapeType when no outputSchema is declared", () => {
    const dts = screenTypings({
      catalog: [],
      queries: [{ name: "invoices", tool: "maple_invoices_list" }],
      toolShapes: { maple_invoices_list: invoicesShape },
    });
    expect(dts).toContain("declare const invoices: { data: Array<{ id: string; amount_cents: number }>; total: number }");
  });

  it("prefers the declared outputSchema over the observed shape", () => {
    const dts = screenTypings({
      catalog: [],
      queries: [{ name: "invoices", tool: "maple_invoices_list" }],
      toolOutputSchemas: { maple_invoices_list: { type: "object", properties: { declared: { type: "string" } }, required: ["declared"], additionalProperties: false } },
      toolShapes: { maple_invoices_list: invoicesShape },
    });
    expect(dts).toContain("declare const invoices: { declared: string }");
    expect(dts).not.toContain("amount_cents");
  });

  it("types a query permissively when neither schema nor shape is known", () => {
    const dts = screenTypings({ catalog: [], queries: [{ name: "mystery", tool: "unsampled" }] });
    expect(dts).toContain("declare const mystery: any;");
  });

  it("declares the whole aggregate vocabulary with explicit field args", () => {
    const dts = screenTypings({ catalog: [], queries: [] });
    for (const call of EXPR_CALLS) {
      expect(dts, `${call} must be declared`).toMatch(new RegExp(`declare const ${call}:`, "u"));
    }
    expect(dts).toContain(EXPR_BUCKETS.map((bucket) => `"${bucket}"`).join(" | "));
  });

  it("is deterministic — same input, byte-identical output", () => {
    const input = { catalog, queries: [{ name: "invoices", tool: "maple_invoices_list" }], toolShapes: { maple_invoices_list: invoicesShape } };
    expect(screenTypings(input)).toBe(screenTypings(input));
  });

  it("covers the closed call vocabulary exactly (drift gate)", () => {
    expect(Object.keys(AGGREGATE_FIELD_ARITY).sort()).toEqual([...EXPR_CALLS].sort());
  });

  it("teaches only the Kit names the wire adopts", () => {
    const dts = screenTypings({ catalog: [], queries: [] });
    for (const name of KIT_WIRE_COMPONENT_NAMES) expect(dts).toContain(`declare const ${name}:`);
  });
});
