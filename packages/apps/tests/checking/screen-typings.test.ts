/**
 * The generator's contract: deterministic declaration text, derived from the
 * schemas the system already has, never a hand-written list.
 */
import {
  shapeFromJsonSchema,
  type JsonSchema,
} from "@vendoai/core";
import {
  KIT_SCREEN_COMPONENT_NAMES,
  type NormalizedCatalog,
} from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { screenTypings, zodTypeText } from "../../src/server/checking/screen-typings.js";

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

/** The same response, declared: the shape the host's own contract states. */
const invoicesSchema: JsonSchema = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, amount_cents: { type: "number" } },
        required: ["id", "amount_cents"],
        additionalProperties: false,
      },
    },
    total: { type: "number" },
  },
  required: ["data", "total"],
  additionalProperties: false,
};

describe("screenTypings", () => {
  it("declares every screen component name as a JSX value", () => {
    const dts = screenTypings({ catalog: [], queries: [] });
    for (const name of KIT_SCREEN_COMPONENT_NAMES) {
      expect(dts, `${name} must be declared`).toContain(`declare const ${name}:`);
    }
  });

  it("carries the Kit's zod prop types, not just its prop names", () => {
    const dts = screenTypings({ catalog: [], queries: [] });
    // Money.amount is a number of DOLLARS (data class); currency an optional
    // string. Every prop also admits VendoBinding — see the unresolvable-binding
    // test below. `amount` is optional since the cell slots landed: a value
    // component inside a cell takes its value from `field`, so a required
    // `amount` would make the slot the catalog teaches unwritable.
    expect(dts).toContain("declare const Money: (props: { amount?: number | VendoBinding; currency?: string | VendoBinding;");
    // Required is still required where it is load-bearing — a table with no rows
    // is nothing at all, and that is what pins the marker itself.
    expect(dts).toContain("declare const DataTable: (props: { rows: Array<Record<string, any>> | VendoBinding;");
    // Stat.format is an enum — the literal union is what makes format=\"huge\" a type error.
    expect(dts).toContain('format?: "money" | "date" | "datetime" | "time" | "percent" | "number" | "duration" | "text"');
    // A cell slot holds an ELEMENT, which no schema describes. A STORED
    // document's is a serialized one, so the wire's slot stays permissive — the
    // alias, not a shape — and without that the catalog's own DataTable example
    // would not compile.
    expect(dts).toContain("cell?: VendoSlot }> | VendoBinding");
    expect(dts).toContain("declare type VendoSlot = any;");
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
    // The exact slot the regression hit — Text.text, a string | number (optional
    // since the cell slots landed, where `field` supplies it instead).
    expect(dts).toContain("text?: string | number | VendoBinding");
    // An enum slot keeps its literal union — format="huge" is still a type error.
    expect(dts).toContain('format?: "money" | "date" | "datetime" | "time" | "percent" | "number" | "duration" | "text" | VendoBinding');
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

  it("types a query from the tool's declared outputSchema", () => {
    const dts = screenTypings({
      catalog: [],
      queries: [{ name: "invoices", tool: "maple_invoices_list" }],
      toolOutputSchemas: { maple_invoices_list: invoicesSchema },
    });
    expect(dts).toContain("declare const invoices: { data: Array<{ id: string; amount_cents: number }>; total: number }");
  });

  it("types a composed (allOf) declared outputSchema as the intersection, not any", () => {
    const dts = screenTypings({
      catalog: [],
      queries: [{ name: "transfer", tool: "maple_transfer" }],
      toolOutputSchemas: {
        maple_transfer: {
          type: "object",
          properties: {
            data: {
              allOf: [
                { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
                { type: "object", properties: { actor: { type: "string" } } },
              ],
            },
          },
          required: ["data"],
        },
      },
    });
    expect(dts).toContain("declare const transfer: { data: { id: string } & { actor?: string } }");
  });

  it("drops a constraint-only allOf branch instead of collapsing the intersection to any", () => {
    const dts = screenTypings({
      catalog: [],
      queries: [{ name: "transfer", tool: "maple_transfer" }],
      toolOutputSchemas: {
        maple_transfer: {
          type: "object",
          properties: {
            data: { allOf: [{ type: "object", properties: { id: { type: "string" } } }, { required: ["id"] }] },
          },
          required: ["data"],
        },
      },
    });
    // `{ id?: string } & any` would be `any`, and every binding through it valid.
    expect(dts).toContain("declare const transfer: { data: { id?: string } }");
  });

  it("keeps sibling properties alongside allOf, so both check floors agree", () => {
    const data = {
      allOf: [{ type: "object", properties: { id: { type: "string" }, actor: { type: "string" } }, required: ["id"] }],
      properties: { total: { type: "number" } },
      required: ["total"],
    };
    const dts = screenTypings({
      catalog: [],
      queries: [{ name: "transfer", tool: "maple_transfer" }],
      toolOutputSchemas: { maple_transfer: { type: "object", properties: { data }, required: ["data"] } },
    });
    // Dropping `total` here would REJECT a binding the declared contract allows
    // and core's shapeFromJsonSchema admits — a false finding, not a loose one.
    expect(dts).toContain("declare const transfer: { data: { id: string; actor?: string } & { total: number } }");
    const shape = shapeFromJsonSchema(data as JsonSchema);
    expect(shape.kind === "object" ? Object.keys(shape.fields).sort() : []).toEqual(["actor", "id", "total"]);
  });

  it("types a query permissively when no schema is declared", () => {
    const dts = screenTypings({ catalog: [], queries: [{ name: "mystery", tool: "undeclared" }] });
    expect(dts).toContain("declare const mystery: any;");
  });

  /**
   * The old dialect's closed call vocabulary (`sum`/`count`/`group_by`/… plus
   * the reshape calls) was declared here so tsc had a shape for it. A `{...}`
   * gap is a real JavaScript expression now — `invoices.data.reduce((t, r) => t
   * + r.amount_cents, 0)` type-checks against the query's own declared result
   * type with nothing ambient in the way — so declaring those names again would
   * type-check calls the renderer cannot evaluate.
   */
  it("declares no call vocabulary — a computed gap is real JavaScript", () => {
    const dts = screenTypings({ catalog: [], queries: [] });
    const retired = ["sum", "count", "average", "min", "max", "difference", "days_until", "group_by", "asPoints", "asOptions"];
    for (const call of retired) {
      expect(dts, `${call} must NOT be declared`).not.toMatch(new RegExp(`declare const ${call}\\b`, "u"));
    }
  });

  it("is deterministic — same input, byte-identical output", () => {
    const input = { catalog, queries: [{ name: "invoices", tool: "maple_invoices_list" }], toolOutputSchemas: { maple_invoices_list: invoicesSchema } };
    expect(screenTypings(input)).toBe(screenTypings(input));
  });
});

/**
 * THE NET UNDER THE WALKER — the branch that exists so a prop we cannot type
 * precisely degrades to `any` instead of becoming a false finding.
 *
 * It had never been reached by a test, and on 0.27.1 it could not be: the
 * switch it sits under compared `undefined` to `undefined` against a zod 4 def
 * and matched its FIRST case, so every unrecognizable schema came back
 * `string` — a confident wrong answer where the whole design says to say
 * nothing. These are the shapes that must land here.
 */
describe("a schema the printer cannot read is typed as any, and says so", () => {
  const cases: ReadonlyArray<[string, unknown]> = [
    ["a construct outside the vocabulary", { _def: { typeName: "ZodPromise" } }],
    ["a zod 4 construct outside the vocabulary", { _def: { type: "promise" } }],
    ["a def wearing no tag at all", { _def: {} }],
    ["an object with no def", {}],
    ["nothing at all", undefined],
  ];

  for (const [what, schema] of cases) {
    it(`degrades ${what} to any`, () => {
      const notes: string[] = [];
      expect(zodTypeText(schema as never, 0, (reason) => notes.push(reason))).toBe("any");
      // Silence is the failure mode this sink exists to end: the gate stops
      // checking that prop, and nothing about the generated text shows it.
      expect(notes.join(" ")).toContain("not in the printer's vocabulary");
    });
  }

  it("names the tag it could not read, so an operator knows what to add", () => {
    const notes: string[] = [];
    zodTypeText({ _def: { type: "promise" } } as never, 0, (reason) => notes.push(reason));
    expect(notes.join(" ")).toContain("promise");
  });
});
