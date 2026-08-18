/**
 * The static half's own contract: real compiler diagnostics, translated into
 * findings a model can act on — and total silence when there is no compiler.
 */
import type {
  JsonSchema,
} from "@vendoai/core";
import type {
  NormalizedCatalog,
} from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { screenTypings } from "../../src/server/checking/screen-typings.js";
import { screenTscFindings, __setCompilerForTests } from "../../src/server/checking/screen-tsc.js";

/** The tool's DECLARED response contract — the only source the screen type
 *  check reads. */
const invoicesSchema: JsonSchema = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, amount_cents: { type: "number" }, issued_at: { type: "string" } },
        required: ["id", "amount_cents", "issued_at"],
        additionalProperties: false,
      },
    },
    total_cents: { type: "number" },
  },
  required: ["data", "total_cents"],
  additionalProperties: false,
};

const netWorthSchema: JsonSchema = {
  type: "object",
  properties: {
    valueCents: { type: "number" },
    series: { type: "array", items: { type: "number" } },
  },
  required: ["valueCents", "series"],
  additionalProperties: false,
};

const catalog: NormalizedCatalog = [
  { name: "MapleNetWorthCard", description: "Net worth", propsJsonSchema: netWorthSchema },
  { name: "MapleFreeform", description: "no schema" },
];

const typings = screenTypings({
  catalog,
  queries: [{ name: "invoices", tool: "maple_invoices_list" }],
  toolOutputSchemas: { maple_invoices_list: invoicesSchema },
});

const check = (screen: string) => screenTscFindings({ screen, typings });

describe("screenTscFindings", () => {
  it("says nothing about a clean screen", () => {
    expect(check(`<App name="Overdue invoices">
  <Query id="invoices" tool="maple_invoices_list"/>
  <Stack gap={12}>
    <Stat label="Total" value={invoices.data.reduce((total, row) => total + row.amount_cents, 0) / 100} unit="USD"/>
    <MapleNetWorthCard valueCents={invoices.total_cents} series={[1, 2, 3]}/>
    <DataTable rows={invoices.data} columns={[{ key: "amount_cents", align: "end" }]}/>
  </Stack>
</App>;
`)).toEqual([]);
  });

  it("names an unknown component in the floor's voice, never a TS code", () => {
    const findings = check('<App name="x"><MapleGhostCard valueCents={1}/></App>;');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("block");
    expect(findings[0]?.where).toBe("<MapleGhostCard>");
    expect(findings[0]?.message).toContain('references unknown component "MapleGhostCard"');
    expect(findings[0]?.message).not.toMatch(/TS\d|error TS/u);
  });

  it("names an unknown prop and lists the ones the component really reads", () => {
    const findings = check('<App name="x"><DataTable data={invoices.data}/></App>;');
    // Two, since V4: the unknown prop, AND the required `rows` it displaced.
    // (The retired Table's `rows` was optional, so this used to be one.)
    expect(findings.map((finding) => finding.where)).toContain('<DataTable> prop "data"');
    const unknownProp = findings.find((finding) => finding.where === '<DataTable> prop "data"');
    expect(unknownProp?.message).toContain('sets unknown prop "data"');
    expect(unknownProp?.message).toContain("rows");
    expect(findings.map((finding) => finding.message).join(" ")).toContain('missing required prop "rows"');
  });

  it("names a missing required prop", () => {
    const findings = check('<App name="x"><MapleNetWorthCard series={[1]}/></App>;');
    expect(findings.map((finding) => finding.message).join(" ")).toContain('is missing required prop "valueCents"');
  });

  it("names a prop type mismatch in plain language", () => {
    const findings = check('<App name="x"><MapleNetWorthCard valueCents={invoices.data} series={[1]}/></App>;');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.where).toBe('<MapleNetWorthCard> prop "valueCents"');
    expect(findings[0]?.message).toContain("takes number");
    expect(findings[0]?.message).toContain("bind a value whose type matches the prop");
  });

  it("names a field the tool's response shape does not carry, with the real fields", () => {
    const findings = check('<App name="x"><Stat label="a" value={invoices.totalCents}/></App>;');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('reads field "totalCents"');
    expect(findings[0]?.message).toContain("the real fields are: data, total_cents");
  });

  /** A computed value is a real JavaScript expression, so a wrong field on the
   *  ROW — inside the lambda, where no dotted path reaches — is the compiler's
   *  own property error against the query's declared item type. */
  it("names a wrong field inside a computed value, with the fields the rows really carry", () => {
    const findings = check('<App name="x"><Stat label="a" value={invoices.data.reduce((total, row) => total + row.amount_centz, 0)}/></App>;');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.where).toBe('<Stat> prop "value"');
    expect(findings[0]?.message).toBe(
      'reads field "amount_centz", which the tool\'s response shape does not carry'
      + " — the real fields are: id, amount_cents, issued_at",
    );
  });

  it("stays quiet on a schema-less catalog entry — 01-core §14 is permissive", () => {
    expect(check('<App name="x"><MapleFreeform whateverTheModelGuessed={invoices.data}/></App>;')).toEqual([]);
  });

  it("reads one segment off $state, never a deeper path — the settled single-segment rule (#808)", () => {
    // `state.<key>` reads any runtime value and is fine; `state.<key>.<deeper>`
    // is a type error the `Record<string, unknown>` shim enforces, because the
    // renderer would silently drop the deeper access.
    expect(check('<App name="x"><Stat label="a" value={state.total}/></App>;')).toEqual([]);
    const deep = check('<App name="x"><Stat label="a" value={state.total.cents}/></App>;');
    expect(deep.length).toBeGreaterThan(0);
    expect(deep.every((finding) => finding.severity === "block")).toBe(true);
  });

  it("reports a syntax error once, plainly, instead of a cascade of type noise", () => {
    const findings = check('<App name="x"><Stack gap={12}></App>;');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.severity === "block")).toBe(true);
    expect(findings.map((finding) => finding.message).join(" ")).toContain("does not parse");
  });

  it("never throws, whatever the screen text is", () => {
    for (const screen of ["", "((((", " \t\n ", "<".repeat(500), "}{"]) {
      expect(() => check(screen)).not.toThrow();
    }
  });

  it("skips silently when no compiler can be loaded — a check never fails a build", () => {
    const restore = __setCompilerForTests(null);
    try {
      expect(check('<App name="x"><MapleGhostCard/></App>;')).toEqual([]);
    } finally {
      restore();
    }
  });

  it("skips silently when the host compiler predates the API the check calls", () => {
    const restore = __setCompilerForTests({ version: "4.7.4" } as never);
    try {
      expect(check('<App name="x"><MapleGhostCard/></App>;')).toEqual([]);
    } finally {
      restore();
    }
  });

  it("anchors a finding on the line when there is no enclosing element", () => {
    const findings = check("{ nothingDeclared };");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.where).toBe("line 1");
  });
});
