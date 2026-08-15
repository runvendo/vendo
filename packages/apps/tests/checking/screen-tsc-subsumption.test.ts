/**
 * The subsumption proof: for every bespoke static check tsc is meant to
 * replace, the SAME defect goes through the bespoke check and through
 * {@link screenTscFindings}, and both must report. This is the evidence that
 * lets the bespoke check be deleted — nothing else is.
 *
 * The two halves read the two artifacts they really read. The bespoke walkers
 * take a `Tree` — a stored document's own tree, with `$path` bindings still in
 * it — so the fixtures below build one directly; the wire compiler that used to
 * make one out of markup is gone, and a component screen's RENDERED tree carries
 * values where these walkers look for bindings. The tsc half reads the `app.tsx`
 * source that says the same thing, through the same typings and lib the floor's
 * `screen-types` check uses. Two artifacts, one defect, two checkers, no stub on
 * either side.
 *
 * Gaps are asserted too — the cases where the compiler CANNOT see what the
 * bespoke check sees are pinned by a test that expects silence, so a gap can
 * never be quietly reclassified as coverage.
 */
import {
  type JsonSchema,
  type ShapeType,
} from "@vendoai/core";
import {
  checkBindingShapes,
  type NormalizedCatalog,
  type StandardSchema,
  type Tree,
} from "../../src/contract/index.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { bindingKindIssues, catalogIssues, kitSlotIssues } from "../../src/server/checking/facts.js";
import {
  COMPONENT_SCREEN_LIB,
  componentScreenTypings,
  screenCatalog,
} from "../../src/server/checking/screen-typings.js";
import { screenTscFindings } from "../../src/server/checking/screen-tsc.js";
// The bespoke checks under test take the floor's own dependency type; using it
// (not `GenerationDependencies` from ../generation/) keeps this test inside the
// §7.3 floor-independence guard that deps.test.ts enforces.
import type { FloorDependencies, HostToolInfo } from "../../src/server/checking/deps.js";
import { scriptedLanguageModel } from "../../src/server/testing/scripted-model.js";

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
const outputSchema: JsonSchema = {
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

const hostTools: HostToolInfo[] = [
  {
    name: TOOL,
    description: "invoices",
    risk: "read",
    inputSchema: { type: "object", properties: { accountId: { type: "string" } } },
    outputSchema,
  },
];

const deps = (): FloorDependencies => ({
  model: scriptedLanguageModel(() => "unused"),
  catalog,
  tools: hostTools,
  toolShapes,
});

const typings = componentScreenTypings({ catalog: screenCatalog(catalog), tools: hostTools });

// ---- the two artifacts ----------------------------------------------------

/** One node of a stored tree. `source` is the branch every bespoke walker keys
 *  off, so each fixture states its own. */
type Node = Tree["nodes"][number];

/** A stored tree as the floor reads one: the nodes under a root, and the query
 *  their `$path` bindings point at. */
const tree = (...nodes: Node[]): Tree => ({
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [
    { id: "root", component: "Stack", source: "prewired", children: nodes.map(({ id }) => id) } as Node,
    ...nodes,
  ],
  queries: [{ name: "invoices", tool: TOOL }],
} as unknown as Tree);

const path = ($path: string): { $path: string } => ({ $path });

/** The `app.tsx` that says the same thing. */
const screen = (body: string, imports: string): string =>
  `import { Stack, useQuery, ${imports} } from "@vendo/screen";

export default function Invoices() {
  const invoices = useQuery(${JSON.stringify(TOOL)});
  return (
    <Stack gap={12}>
      ${body}
    </Stack>
  );
}
`;

const tsc = (source: string) => screenTscFindings({ screen: source, typings, lib: COMPONENT_SCREEN_LIB });

/** Both checkers must speak, on one defect. The messages are asserted for
 *  substance, not wording — the point is that a model reading either one learns
 *  the same fact. */
const bothReport = async (
  source: string,
  bespokeMessages: readonly string[] | Promise<readonly string[]>,
) => {
  const bespoke = await bespokeMessages;
  const tscFindings = tsc(source);
  expect(bespoke.length, "the bespoke check must catch this — otherwise the fixture is wrong").toBeGreaterThan(0);
  expect(tscFindings.length, `tsc found nothing; bespoke said: ${bespoke.join(" / ")}`).toBeGreaterThan(0);
  return { bespoke, tsc: tscFindings };
};

describe("tsc subsumes components-exist (the unresolved-name branches)", () => {
  const GHOST = screen('<MapleGhostCard valueCents={invoices.total_cents} />', "MapleGhostCard");

  it("a name in no vocabulary at all is an unresolved import", async () => {
    // A tree whose node carries no `source` reaches catalogIssues through its
    // source-less branch (facts.ts) — the shape a legacy or hand-written tree has.
    const ghost = tree({ id: "ghost", component: "MapleGhostCard", props: { valueCents: path("/invoices/total_cents") } } as Node);
    const { bespoke, tsc: findings } = await bothReport(
      GHOST,
      catalogIssues(ghost, undefined, catalog).then((issues) => issues.map((issue) => issue.message)),
    );
    expect(bespoke[0]).toContain('references unknown component "MapleGhostCard"');
    expect(findings.map((finding) => finding.message).join(" ")).toContain("MapleGhostCard");
  });

  it("a node stamped source:\"host\" but absent from the catalog is the same error", async () => {
    // The HOST branch proper — reached by a stored or edited tree whose node
    // names a host component the catalog no longer carries.
    const ghost = tree({ id: "ghost", component: "MapleGhostCard", source: "host", props: {} } as Node);
    const bespoke = await catalogIssues(ghost, undefined, catalog);
    expect(bespoke[0]?.message).toContain('references host component "MapleGhostCard" absent from the catalog');
    expect(tsc(GHOST).map((finding) => finding.message).join(" ")).toContain("MapleGhostCard");
  });
});

describe("tsc subsumes components-exist (hostPropsIssues)", () => {
  const hostNode = (props: Record<string, unknown>): Tree =>
    tree({ id: "card", component: "MapleNetWorthCard", source: "host", props } as Node);

  it("a host prop whose LITERAL value has the wrong type is a JSX assignability error", async () => {
    const { bespoke, tsc: findings } = await bothReport(
      screen('<MapleNetWorthCard valueCents="lots" series={[1]} />', "MapleNetWorthCard"),
      catalogIssues(hostNode({ valueCents: "lots", series: [1] }), undefined, catalog)
        .then((issues) => issues.map((issue) => issue.message)),
    );
    expect(bespoke.join(" ")).toContain("MapleNetWorthCard");
    expect(findings.some((finding) => finding.message.includes('prop "valueCents"'))).toBe(true);
  });

  it("STRENGTHENING: the bespoke check cannot type a $path value; tsc can", async () => {
    // `pathTargetsRuntimeBinding` (facts.ts) deliberately skips any props path
    // that reaches a runtime binding, because the tree carries a `$path` object
    // where the schema wants a number. In the TSX dialect the binding IS a typed
    // expression, so the same screen is a plain assignability error. This is
    // strictly more coverage, not a substitute for a bespoke finding.
    const bound = hostNode({ valueCents: path("/invoices/label"), series: [1] });
    expect(await catalogIssues(bound, undefined, catalog)).toEqual([]);
    const findings = tsc(screen('<MapleNetWorthCard valueCents={invoices.label} series={[1]} />', "MapleNetWorthCard"));
    expect(findings.some((finding) => finding.message.includes('prop "valueCents"'))).toBe(true);
  });

  it("a host prop the schema does not declare is a JSX unknown-attribute error", () => {
    const findings = tsc(screen(
      '<MapleNetWorthCard valueCents={invoices.total_cents} series={[1]} sparkle="yes" />',
      "MapleNetWorthCard",
    ));
    expect(findings.some((finding) => finding.message.includes('sets unknown prop "sparkle"'))).toBe(true);
    expect(findings.some((finding) => finding.message.includes("Allowed props: valueCents, series"))).toBe(true);
  });

  it("a missing required host prop is a JSX missing-property error", async () => {
    const { bespoke, tsc: findings } = await bothReport(
      screen('<MapleNetWorthCard series={[1]} />', "MapleNetWorthCard"),
      catalogIssues(hostNode({ series: [1] }), undefined, catalog)
        .then((issues) => issues.map((issue) => issue.message)),
    );
    expect(bespoke.join(" ")).toContain("valueCents");
    expect(findings.some((finding) => finding.message.includes('is missing required prop "valueCents"'))).toBe(true);
  });
});

describe("tsc subsumes components-exist (prewiredPropsIssues)", () => {
  it("DataTable.data instead of DataTable.rows is a JSX unknown-attribute error", async () => {
    const { bespoke, tsc: findings } = await bothReport(
      screen('<DataTable data={invoices.data} />', "DataTable"),
      catalogIssues(
        tree({ id: "table", component: "DataTable", source: "prewired", props: { data: path("/invoices/data") } } as Node),
        undefined,
        catalog,
      ).then((issues) => issues.map((issue) => issue.message)),
    );
    expect(bespoke[0]).toContain('sets unknown prop "data" on prewired component "DataTable"');
    expect(findings[0]?.message).toContain('sets unknown prop "data" on <DataTable>');
    expect(findings[0]?.message).toContain("rows");
  });

  it("Button.onPress instead of onClick is a JSX unknown-attribute error", async () => {
    const { bespoke, tsc: findings } = await bothReport(
      screen('<Button label="Remind" onPress={() => undefined} />', "Button"),
      catalogIssues(
        tree({ id: "button", component: "Button", source: "prewired", props: { label: "Remind", onPress: "maple_remind" } } as Node),
        undefined,
        catalog,
      ).then((issues) => issues.map((issue) => issue.message)),
    );
    expect(bespoke[0]).toContain('unknown prop "onPress"');
    expect(findings[0]?.message).toContain('sets unknown prop "onPress"');
    expect(findings[0]?.message).toContain("onClick");
  });
});

describe("tsc subsumes bindings-fit (bindingKindIssues)", () => {
  const hostNode = (props: Record<string, unknown>): Tree =>
    tree({ id: "card", component: "MapleNetWorthCard", source: "host", props } as Node);

  it("a string field bound into a numeric host prop is a JSX assignability error", async () => {
    const { bespoke, tsc: findings } = await bothReport(
      screen('<MapleNetWorthCard valueCents={invoices.label} series={[1]} />', "MapleNetWorthCard"),
      bindingKindIssues(hostNode({ valueCents: path("/invoices/label"), series: [1] }), deps())
        .map((issue) => issue.message),
    );
    expect(bespoke[0]).toContain("expected a number, the bound field is string");
    expect(findings[0]?.message).toContain('prop "valueCents"');
    expect(findings[0]?.message).toContain("takes number");
  });

  it("a rows array bound into a number[] host prop is a JSX assignability error", async () => {
    const { bespoke, tsc: findings } = await bothReport(
      screen('<MapleNetWorthCard valueCents={invoices.total_cents} series={invoices.data} />', "MapleNetWorthCard"),
      bindingKindIssues(hostNode({ valueCents: 1, series: path("/invoices/data") }), deps())
        .map((issue) => issue.message),
    );
    expect(bespoke[0]).toContain("expected a number, the bound field is object");
    expect(findings[0]?.message).toContain('prop "series"');
  });
});

describe("tsc subsumes bindings-fit (kitSlotIssues)", () => {
  it("a string field bound into Money.amount is a JSX assignability error", async () => {
    const { bespoke, tsc: findings } = await bothReport(
      screen('<Money amount={invoices.label} />', "Money"),
      kitSlotIssues(
        tree({ id: "money", component: "Money", props: { amount: path("/invoices/label") } } as Node),
        deps(),
      ).map((issue) => issue.message),
    );
    expect(bespoke[0]).toContain("binds /invoices/label, a string field");
    expect(findings[0]?.message).toContain('prop "amount" on <Money> takes number');
  });

  it("rows bound into Percent.value is a JSX assignability error", async () => {
    const { bespoke, tsc: findings } = await bothReport(
      screen('<Percent value={invoices.data} />', "Percent"),
      kitSlotIssues(
        tree({ id: "percent", component: "Percent", props: { value: path("/invoices/data") } } as Node),
        deps(),
      ).map((issue) => issue.message),
    );
    expect(bespoke[0]).toContain("a array field");
    expect(findings[0]?.message).toContain('prop "value" on <Percent> takes number');
  });
});

describe("tsc subsumes bindings-fit (bindingShapeIssues — the field-existence half)", () => {
  it("a field the response shape does not carry is a property-access error", async () => {
    const bad = tree({ id: "table", component: "DataTable", props: { rows: path("/invoices/rowz") } } as Node);
    const { bespoke, tsc: findings } = await bothReport(
      screen('<DataTable rows={invoices.rowz} />', "DataTable"),
      checkBindingShapes(bad.nodes, bad.queries ?? [], toolShapes).map((error) => error.message),
    );
    expect(bespoke[0]).toContain('field "rowz" is absent from the tool\'s response shape');
    expect(findings[0]?.message).toContain('reads field "rowz"');
    expect(findings[0]?.message).toContain("the real fields are: label, total_cents, data");
  });

  it("a nested field the response shape does not carry is a property-access error", () => {
    const findings = tsc(screen('<Stat label="Total" value={invoices.data[0].amount_centz} />', "Stat"));
    expect(findings.some((finding) => finding.message.includes('reads field "amount_centz"'))).toBe(true);
  });
});

describe("the honest gap list — what tsc CANNOT see", () => {
  it("GAP: a query input carrying a live value is structurally valid TypeScript", () => {
    // `query-inputs-literal` stays: a second `useQuery` whose input reads the
    // first one's result is a perfectly well-typed argument. The prohibition is
    // semantic.
    expect(tsc(`import { Stack, Text, useQuery } from "@vendo/screen";

export default function Invoices() {
  const invoices = useQuery(${JSON.stringify(TOOL)});
  const one = useQuery(${JSON.stringify(TOOL)}, { accountId: invoices.label });
  return <Stack gap={12}><Text text={one.label} /></Stack>;
}
`)).toEqual([]);
  });

  it("GAP: a binding interpolated inside a string is a valid string", () => {
    // `no-string-interpolation` stays.
    expect(tsc(screen('<Text text="Total: {invoices.total_cents}" />', "Text"))).toEqual([]);
  });

  /** CLOSED by V4 (one component family). This used to be a gap: the legacy
   *  prewired primitives carried no schema, only an allowed prop-NAME set, so
   *  `<Stat value={rows}/>` type-checked where a Kit `<Money amount={...}/>`
   *  would not. Retiring them left one Stat with a real zod-derived type, so
   *  the wrongly-typed binding is now caught like any other. */
  it("no longer a gap: every built-in carries its Kit prop TYPES, not just names", () => {
    const findings = tsc(screen('<Stat label="Total" value={invoices.data} />', "Stat"));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map((finding) => finding.message).join(" ")).toContain('prop "value" on <Stat>');
  });

  /** CLOSED by the component dialect. A tool name used to be a bare string the
   *  compiler had no opinion about, so `tools-exist` was the only thing that
   *  could say a query named nothing real. `useQuery` is overloaded once per
   *  declared read tool now, so an unknown name matches no overload. */
  it("no longer a gap: an unknown tool name matches no useQuery overload", () => {
    const findings = tsc(`import { Stack } from "@vendo/screen";
import { useQuery } from "@vendo/screen";

export default function Invoices() {
  const rows = useQuery("not_a_real_tool");
  return <Stack gap={12}>{String(rows)}</Stack>;
}
`);
    expect(findings.length).toBeGreaterThan(0);
  });
});
