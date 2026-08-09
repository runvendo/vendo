/**
 * The subsumption proof: for every bespoke static check tsc is meant to
 * replace, the SAME bad screen goes through the bespoke check and through
 * {@link screenTscFindings}, and both must report. This is the evidence that
 * lets the bespoke check be deleted — nothing else is.
 *
 * The screens are WIRE TEXT, compiled once for the bespoke checks (which read a
 * `Tree`) and handed verbatim to the tsc check (which reads the file). One
 * input, two checkers, no stub on either side.
 *
 * Gaps are asserted too — the cases where the compiler CANNOT see what the
 * bespoke check sees are pinned by a test that expects silence, so a gap can
 * never be quietly reclassified as coverage.
 */
import {
  VENDO_APP_FORMAT,
  checkBindingShapes,
  compileWire,
  type AppDocument,
  type JsonSchema,
  type NormalizedCatalog,
  type ShapeType,
  type StandardSchema,
  type Tree,
} from "@vendoai/core";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { bindingKindIssues, catalogIssues, kitSlotIssues } from "../../src/checking/facts.js";
import { screenTypings } from "../../src/checking/screen-typings.js";
import { screenTscFindings } from "../../src/checking/screen-tsc.js";
// The bespoke checks under test take the floor's own dependency type; using it
// (not `GenerationDependencies` from ../generation/) keeps this test inside the
// §7.3 floor-independence guard that deps.test.ts enforces.
import type { FloorDependencies } from "../../src/checking/deps.js";
import { scriptedLanguageModel } from "../../src/testing/scripted-model.js";

const TOOL = "maple_invoices_list";

/** One tool response with a string field and a rows array at the top level —
 *  enough to bind both a well-typed and a badly-typed prop. */
const shape: ShapeType = {
  kind: "object",
  fields: {
    label: { kind: "string" },
    total_cents: { kind: "number" },
    data: {
      kind: "array",
      items: { kind: "object", fields: { id: { kind: "string" }, amount_cents: { kind: "number" } } },
    },
  },
};

const toolShapes: Record<string, ShapeType> = { [TOOL]: shape };

/** The SAME response as a declared JSON Schema — what the screen type check
 *  reads now that nothing samples. */
const toolOutputSchemas: Record<string, JsonSchema> = {
  [TOOL]: {
    type: "object",
    properties: {
      label: { type: "string" },
      total_cents: { type: "number" },
      data: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, amount_cents: { type: "number" } },
          required: ["id", "amount_cents"],
          additionalProperties: false,
        },
      },
    },
    required: ["label", "total_cents", "data"],
    additionalProperties: false,
  },
};

/** The JSON Schema a host component's props derive to at composition. */
const netWorthJsonSchema: JsonSchema = {
  type: "object",
  properties: { valueCents: { type: "number" }, series: { type: "array", items: { type: "number" } } },
  required: ["valueCents", "series"],
  additionalProperties: false,
};

/** The SAME contract as a standard schema — what `hostPropsIssues` validates
 *  against. A real catalog entry carries both: the zod schema the host
 *  registered, and the JSON Schema derived from it. */
const netWorthStandardSchema = z.object({
  valueCents: z.number(),
  series: z.array(z.number()),
}) as unknown as StandardSchema;

const catalog: NormalizedCatalog = [{
  name: "MapleNetWorthCard",
  description: "Net worth",
  propsSchema: netWorthStandardSchema,
  propsJsonSchema: netWorthJsonSchema,
}];

const deps = (): FloorDependencies => ({
  model: scriptedLanguageModel(() => '<App name="unused"/>'),
  catalog,
  tools: [{ name: TOOL, description: "invoices", risk: "read", inputSchema: { type: "object", properties: {} } }],
  toolShapes,
});

const typings = screenTypings({
  catalog,
  queries: [{ name: "invoices", tool: TOOL }],
  toolOutputSchemas,
});

const screen = (body: string): string =>
  `<App name="Invoices"><Query id="invoices" tool="${TOOL}"/>${body}</App>`;

const treeOf = (wire: string): Tree => {
  // `hostComponents` is what makes the compiler stamp `source: "host"` — the
  // branch every host-side bespoke check keys off. Without it the fixtures
  // would silently exercise the legacy source-less branch instead.
  const compiled = compileWire(wire, { toolShapes, hostComponents: catalog.map((entry) => entry.name) });
  const document = {
    format: VENDO_APP_FORMAT,
    id: "app_subsumption",
    name: compiled.name ?? "Untitled",
    ui: "tree",
    tree: compiled.tree,
  } as unknown as AppDocument;
  const tree = document.tree;
  if (tree === undefined) throw new Error("fixture failed to compile to a tree");
  return tree as unknown as Tree;
};

const tsc = (wire: string) => screenTscFindings({ screen: wire, typings });

/** Both checkers must speak, on one input. The messages are asserted for
 *  substance, not wording — the point is that a model reading either one learns
 *  the same fact. */
const bothReport = async (wire: string, bespoke: (tree: Tree) => Promise<string[]> | string[]) => {
  const tree = treeOf(wire);
  const bespokeMessages = await bespoke(tree);
  const tscFindings = tsc(wire);
  expect(bespokeMessages.length, "the bespoke check must catch this — otherwise the fixture is wrong").toBeGreaterThan(0);
  expect(tscFindings.length, `tsc found nothing; bespoke said: ${bespokeMessages.join(" / ")}`).toBeGreaterThan(0);
  return { bespoke: bespokeMessages, tsc: tscFindings };
};

describe("tsc subsumes components-exist (the unresolved-name branches)", () => {
  const GHOST = screen('<MapleGhostCard valueCents={invoices.total_cents}/>');

  it("a name in no vocabulary at all is an unresolved JSX element", async () => {
    // The compiler leaves `source` unset for a name it cannot place, so
    // catalogIssues reports through its source-less branch (facts.ts:385-387).
    const { bespoke, tsc: findings } = await bothReport(GHOST, async (tree) =>
      (await catalogIssues(tree, undefined, catalog)).map((issue) => issue.message));
    expect(bespoke[0]).toContain('references unknown component "MapleGhostCard"');
    expect(findings[0]?.message).toContain('references unknown component "MapleGhostCard"');
    expect(findings[0]?.where).toBe("<MapleGhostCard>");
  });

  it("a node stamped source:\"host\" but absent from the catalog is the same error", async () => {
    // The HOST branch proper (facts.ts:363-369) — reached by a stored or edited
    // tree whose node names a host component the catalog no longer carries.
    const compiled = compileWire(GHOST, { toolShapes, hostComponents: ["MapleGhostCard"] });
    const tree = compiled.tree as Tree;
    expect(tree.nodes.some((node) => node.component === "MapleGhostCard" && node.source === "host")).toBe(true);
    const bespoke = await catalogIssues(tree, undefined, catalog);
    expect(bespoke[0]?.message).toContain('references host component "MapleGhostCard" absent from the catalog');
    expect(tsc(GHOST)[0]?.message).toContain('references unknown component "MapleGhostCard"');
  });
});

describe("tsc subsumes components-exist (hostPropsIssues)", () => {
  it("a host prop whose LITERAL value has the wrong type is a JSX assignability error", async () => {
    const wire = screen('<MapleNetWorthCard valueCents="lots" series={[1]}/>');
    const { bespoke, tsc: findings } = await bothReport(wire, async (tree) =>
      (await catalogIssues(tree, undefined, catalog)).map((issue) => issue.message));
    expect(bespoke.join(" ")).toContain("MapleNetWorthCard");
    expect(findings.some((finding) => finding.message.includes('prop "valueCents"'))).toBe(true);
  });

  it("STRENGTHENING: the bespoke check cannot type a $path value; tsc can", async () => {
    // `pathTargetsRuntimeBinding` (facts.ts) deliberately skips any props path
    // that reaches a runtime binding, because the tree carries a `$path` object
    // where the schema wants a number. In the TSX dialect the binding IS a typed
    // expression, so the same screen is a plain assignability error. This is
    // strictly more coverage, not a substitute for a bespoke finding.
    const wire = screen('<MapleNetWorthCard valueCents={invoices.label} series={[1]}/>');
    expect(await catalogIssues(treeOf(wire), undefined, catalog)).toEqual([]);
    expect(tsc(wire).some((finding) => finding.message.includes('prop "valueCents"'))).toBe(true);
  });

  it("a host prop the schema does not declare is a JSX unknown-attribute error", async () => {
    const wire = screen('<MapleNetWorthCard valueCents={invoices.total_cents} series={[1]} sparkle="yes"/>');
    const findings = tsc(wire);
    expect(findings.some((finding) => finding.message.includes('sets unknown prop "sparkle"'))).toBe(true);
    expect(findings.some((finding) => finding.message.includes("Allowed props: valueCents, series"))).toBe(true);
  });

  it("a missing required host prop is a JSX missing-property error", async () => {
    const wire = screen('<MapleNetWorthCard series={[1]}/>');
    const { bespoke, tsc: findings } = await bothReport(wire, async (tree) =>
      (await catalogIssues(tree, undefined, catalog)).map((issue) => issue.message));
    expect(bespoke.join(" ")).toContain("valueCents");
    expect(findings.some((finding) => finding.message.includes('is missing required prop "valueCents"'))).toBe(true);
  });
});

describe("tsc subsumes components-exist (prewiredPropsIssues)", () => {
  it("Table.data instead of Table.rows is a JSX unknown-attribute error", async () => {
    const wire = screen('<DataTable data={invoices.data}/>');
    const { bespoke, tsc: findings } = await bothReport(wire, async (tree) =>
      (await catalogIssues(tree, undefined, catalog)).map((issue) => issue.message));
    expect(bespoke[0]).toContain('sets unknown prop "data" on prewired component "DataTable"');
    expect(findings[0]?.message).toContain('sets unknown prop "data" on <DataTable>');
    expect(findings[0]?.message).toContain("rows");
  });

  it("Button.onPress instead of onClick is a JSX unknown-attribute error", async () => {
    const wire = screen('<Button label="Remind" onPress="maple_remind"/>');
    const { bespoke, tsc: findings } = await bothReport(wire, async (tree) =>
      (await catalogIssues(tree, undefined, catalog)).map((issue) => issue.message));
    expect(bespoke[0]).toContain('unknown prop "onPress"');
    expect(findings[0]?.message).toContain('sets unknown prop "onPress"');
    expect(findings[0]?.message).toContain("onClick");
  });

  it("still allows `pending` — the plan skeleton writes it on every leaf", () => {
    expect(tsc(screen('<DataTable rows={invoices.data} pending={true}/>'))).toEqual([]);
  });
});

describe("tsc subsumes bindings-fit (bindingKindIssues)", () => {
  it("a string field bound into a numeric host prop is a JSX assignability error", async () => {
    const wire = screen('<MapleNetWorthCard valueCents={invoices.label} series={[1]}/>');
    const { bespoke, tsc: findings } = await bothReport(wire, (tree) =>
      bindingKindIssues(tree, deps()).map((issue) => issue.message));
    expect(bespoke[0]).toContain("expected a number, the bound field is string");
    expect(findings[0]?.message).toContain('prop "valueCents"');
    expect(findings[0]?.message).toContain("takes number");
  });

  it("a rows array bound into a number[] host prop is a JSX assignability error", async () => {
    const wire = screen('<MapleNetWorthCard valueCents={invoices.total_cents} series={invoices.data}/>');
    const { bespoke, tsc: findings } = await bothReport(wire, (tree) =>
      bindingKindIssues(tree, deps()).map((issue) => issue.message));
    expect(bespoke[0]).toContain("expected a number, the bound field is object");
    expect(findings[0]?.message).toContain('prop "series"');
  });
});

describe("tsc subsumes bindings-fit (kitSlotIssues)", () => {
  it("a string field bound into Money.cents is a JSX assignability error", async () => {
    const wire = screen('<Money cents={invoices.label}/>');
    const { bespoke, tsc: findings } = await bothReport(wire, (tree) =>
      kitSlotIssues(tree, deps()).map((issue) => issue.message));
    expect(bespoke[0]).toContain("binds /invoices/label, a string field");
    expect(findings[0]?.message).toContain('prop "cents" on <Money> takes number');
  });

  it("rows bound into Percent.value is a JSX assignability error", async () => {
    const wire = screen('<Percent value={invoices.data}/>');
    const { bespoke, tsc: findings } = await bothReport(wire, (tree) =>
      kitSlotIssues(tree, deps()).map((issue) => issue.message));
    expect(bespoke[0]).toContain("a array field");
    expect(findings[0]?.message).toContain('prop "value" on <Percent> takes number');
  });
});

describe("tsc subsumes bindings-fit (bindingShapeIssues — the field-existence half)", () => {
  it("a field the response shape does not carry is a property-access error", async () => {
    const wire = screen('<DataTable rows={invoices.rowz}/>');
    const { bespoke, tsc: findings } = await bothReport(wire, (tree) =>
      checkBindingShapes(tree.nodes, tree.queries ?? [], toolShapes).map((error) => error.message));
    expect(bespoke[0]).toContain('field "rowz" is absent from the tool\'s response shape');
    expect(findings[0]?.message).toContain('reads field "rowz"');
    expect(findings[0]?.message).toContain("the real fields are: label, total_cents, data");
  });

  it("a nested field the response shape does not carry is a property-access error", async () => {
    const wire = screen('<Stat label="Total" value={invoices.data.amount_centz}/>');
    const findings = tsc(wire);
    expect(findings.some((finding) => finding.message.includes('reads field "amount_centz"'))).toBe(true);
  });
});

describe("the honest gap list — what tsc CANNOT see", () => {
  it("GAP: a query input carrying a binding is structurally valid TypeScript", () => {
    // `query-inputs-literal` stays: `input={{accountId: accounts.data}}` is a
    // perfectly well-typed object. The prohibition is semantic.
    const wire = `<App name="x"><Query id="invoices" tool="${TOOL}"/>`
      + `<Query id="one" tool="${TOOL}" input={{ accountId: invoices.label }}/></App>`;
    expect(tsc(wire)).toEqual([]);
  });

  it("GAP: a binding interpolated inside a string is a valid string", () => {
    // `no-string-interpolation` stays.
    expect(tsc(screen('<Text text="Total: {invoices.total_cents}"/>'))).toEqual([]);
  });

  it("GAP: an unknown tool name is a valid string literal", () => {
    // `tools-exist` stays — it is a runtime registry lookup.
    expect(tsc('<App name="x"><Query id="invoices" tool="not_a_real_tool"/></App>')).toEqual([]);
  });

  /** CLOSED by V4 (one component family). This used to be a gap: the legacy
   *  prewired primitives carried no schema, only an allowed prop-NAME set, so
   *  `<Stat value={rows}/>` type-checked where a Kit `<Money cents={...}/>`
   *  would not. Retiring them left one Stat with a real zod-derived type, so
   *  the wrongly-typed binding is now caught like any other. */
  it("no longer a gap: every built-in carries its Kit prop TYPES, not just names", () => {
    const findings = tsc(screen('<Stat label="Total" value={invoices.data}/>'));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map((finding) => finding.message).join(" ")).toContain('prop "value" on <Stat>');
  });

  it("GAP: asPoints into a host prop with its own item fields is a valid call", () => {
    // `hostReshapeIssues` stays — it is a policy about which op may feed which
    // prop, and the reshape ops are declared permissively.
    expect(tsc(screen('<MapleNetWorthCard valueCents={invoices.total_cents} series={asPoints(invoices.data, "id", "amount_cents")}/>'))).toEqual([]);
  });
});
