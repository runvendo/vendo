/**
 * The checks floor, lifted from generation-internal to host-pluggable
 * (build contract §5): the two kinds of check, who runs which, and the
 * guarantees that hold no matter which harness built the app or whether it
 * bothered to review its own work.
 */
import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  type ShapeType,
  type TreeNode,
} from "@vendoai/core";
import {
  type AppDocument,
  type Check,
  type CheckInput,
  type NormalizedCatalog,
  type TreeQuery,
} from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createCheckingLayer } from "../../src/server/checking/layer.js";
import type { FloorDependencies, HostToolInfo } from "../../src/server/checking/deps.js";
import { scriptedLanguageModel } from "../../src/server/testing/scripted-model.js";

const tools: HostToolInfo[] = [{
  name: "host_listInvoices",
  description: "Open invoices",
  risk: "read",
  inputSchema: { type: "object", properties: {} },
}];

const toolShapes: Record<string, ShapeType> = {
  host_listInvoices: {
    kind: "object",
    fields: {
      data: { kind: "array", items: { kind: "object", fields: { id: { kind: "string" } } } },
    },
  },
};

const catalog: NormalizedCatalog = [];

const deps = (): FloorDependencies => ({
  model: scriptedLanguageModel(() => "the reviewer is not wired in these cases"),
  catalog,
  tools,
  toolShapes,
});

/** A stored app as the checks read one: the tree a paint left, under the app's
 *  own id. Hand-built because a tree is a stored structure now — the renderer
 *  and the checks read exactly this, and there is no dialect in between. */
const treeDocument = (
  nodes: TreeNode[],
  queries: TreeQuery[] = [{ name: "invoices", tool: "host_listInvoices" }],
): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_floor_test",
  name: "Invoices",
  ui: "tree",
  tree: {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes,
    queries,
  } as unknown as AppDocument["tree"],
});

const stack = (children: string[], props: Record<string, unknown> = {}): TreeNode =>
  ({ id: "root", component: "Stack", source: "prewired", props, children } as unknown as TreeNode);

const GOOD = treeDocument([
  stack(["n1", "n2"], { gap: 12 }),
  { id: "n1", component: "Text", source: "prewired", props: { text: "Invoices", variant: "heading" } },
  { id: "n2", component: "DataTable", source: "prewired", props: { rows: { $path: "/invoices/data" } } },
] as unknown as TreeNode[]);

/** A deliberately bad app: it names a tool the host does not have. */
const BAD = treeDocument(
  [
    stack(["n2"]),
    { id: "n2", component: "DataTable", source: "prewired", props: { rows: { $path: "/invoices/data" } } },
  ] as unknown as TreeNode[],
  [{ name: "invoices", tool: "host_wireMoney" }],
);

/** Nests a node under a chart. The renderer hands `children` to every node, so
 *  the caption inside the chart paints as nothing at all. */
const NESTED = treeDocument([
  stack(["linechart-1"], { gap: 12 }),
  {
    id: "linechart-1",
    component: "LineChart",
    source: "prewired",
    props: { data: { $path: "/invoices/data" }, xKey: "id", series: ["amount"] },
    children: ["n3"],
  },
  { id: "n3", component: "Text", source: "prewired", props: { text: "Legend" } },
] as unknown as TreeNode[]);

/** A shared adjective on a component that does not read it. `tone` paints
 *  nothing on a table: the prop validates, the renderer drops it, and the model
 *  is told it succeeded — the silent drop the prop-name gate turns into a block. */
const DEAF = treeDocument([
  stack(["datatable-1"]),
  {
    id: "datatable-1",
    component: "DataTable",
    source: "prewired",
    props: { rows: { $path: "/invoices/data" }, tone: "danger" },
  },
] as unknown as TreeNode[]);

const inputFor = (document: AppDocument, request = "show me my invoices"): CheckInput =>
  ({ document, request });

// `kind` is OPTIONAL on the fact variant, so `Extract<Check, { kind: "fact" }>`
// is `never` — the fact half is named by the member only IT has (layer.ts).
const factCheck = (name: string, findings: () => Awaited<ReturnType<Extract<Check, { run: unknown }>["run"]>>): Check =>
  ({ name, kind: "fact", run: async () => findings() });

describe("CheckInput speaks the core document shape (build contract §5)", () => {
  it("takes a stored AppDocument, so a check over a committed app needs no unwrapping", async () => {
    const layer = createCheckingLayer({ deps: deps() });
    let seen: AppDocument | undefined;
    const spy: Check = { name: "spy", kind: "fact", run: async ({ document }) => { seen = document; return []; } };

    await createCheckingLayer({ deps: deps(), checks: [spy] }).run(inputFor(GOOD));

    expect(seen?.id).toBe("app_floor_test");
    expect(await layer.run(inputFor(GOOD))).toEqual([]);
  });
});

describe("fact checks vs judgment rules", () => {
  it("runs fact checks and never runs a judgment rule as code", async () => {
    let ranFact = false;
    const layer = createCheckingLayer({
      deps: deps(),
      checks: [
        { name: "host-fact", kind: "fact", run: async () => { ranFact = true; return []; } },
        { name: "cite-totals", kind: "judgment", rule: "Totals must cite their query." },
      ],
    });

    const findings = await layer.run(inputFor(GOOD));

    expect(ranFact).toBe(true);
    expect(findings).toEqual([]);
  });

  it("exposes judgment rules as separate rubric lines, never concatenated", () => {
    const layer = createCheckingLayer({
      deps: deps(),
      checks: [
        { name: "cite-totals", kind: "judgment", rule: "Totals must cite their query." },
        { name: "no-jargon", kind: "judgment", rule: "Never show a field name to a person." },
      ],
    });

    expect(layer.rubric).toEqual([
      "Totals must cite their query.",
      "Never show a field name to a person.",
    ]);
  });

  it("has an empty rubric when no pack contributed a judgment rule", () => {
    expect(createCheckingLayer({ deps: deps() }).rubric).toEqual([]);
  });

  it("registers both kinds under `checks` so a boot report can name them all", () => {
    const layer = createCheckingLayer({
      deps: deps(),
      checks: [
        { name: "host-fact", kind: "fact", run: async () => [] },
        { name: "cite-totals", kind: "judgment", rule: "Totals must cite their query." },
      ],
    });

    expect(layer.checks.map(({ name }) => name)).toEqual(expect.arrayContaining(["host-fact", "cite-totals"]));
  });
});

describe("the floor holds regardless of the builder", () => {
  it("catches a deliberately bad app with no host check and no reviewer wired", async () => {
    const layer = createCheckingLayer({ deps: deps() });

    const findings = await layer.run(inputFor(BAD));

    expect(findings).toContainEqual({
      severity: "block",
      where: 'query "invoices"',
      message: 'names unknown tool "host_wireMoney"; the host tools are: host_listInvoices',
      check: "tools-exist",
    });
  });

  it("blocks a node nested inside a component that renders no children", async () => {
    // The silent-breakage class this rule exists for: the model wrote a caption,
    // the person got a blank, and nothing said a word.
    const findings = await createCheckingLayer({ deps: deps() }).run(inputFor(NESTED));

    expect(findings).toContainEqual({
      severity: "block",
      where: 'node "linechart-1"',
      message: "nests 1 node inside <LineChart>, which renders nothing nested inside it: that content never reaches the screen. Put it beside <LineChart> in a <Stack>, or give <LineChart> what it showed through its own props.",
      check: "kit-nesting",
    });
  });

  it("blocks a shared adjective on a component that does not read it", async () => {
    const findings = await createCheckingLayer({ deps: deps() }).run(inputFor(DEAF));

    expect(findings).toContainEqual({
      severity: "block",
      where: 'node "datatable-1"',
      message: expect.stringContaining('sets unknown prop "tone" on prewired component "DataTable"'),
      check: "components-exist",
    });
  });

  it("fires a host check even when the builder skipped self-review", async () => {
    // No reviewer check is registered at all — the plugged check is not
    // downstream of anyone's self-review, so it still reports.
    const layer = createCheckingLayer({
      deps: deps(),
      checks: [factCheck("maple-house-style", () => [
        { severity: "block", where: 'node "n2"', message: "Maple never shows a bare table — wrap it in a Card" },
      ])],
    });

    const findings = await layer.run(inputFor(GOOD));

    expect(layer.checks.map(({ name }) => name)).not.toContain("reviewer");
    expect(findings).toContainEqual({
      severity: "block",
      where: 'node "n2"',
      message: "Maple never shows a bare table — wrap it in a Card",
      check: "maple-house-style",
    });
  });

  it("lets a check omit `where` when it cannot name a locus", async () => {
    const layer = createCheckingLayer({
      deps: deps(),
      checks: [factCheck("whole-app", () => [{ severity: "warn", message: "this app feels thin" }])],
    });

    expect(await layer.run(inputFor(GOOD)))
      .toEqual([{ severity: "warn", message: "this app feels thin", check: "whole-app" }]);
  });
});

describe("a check with no kind is a FACT check and still fires (F1)", () => {
  // The floor is a safety floor. Anything that is not explicitly a judgment
  // rule is code we run: a check that quietly stops firing is the worst
  // failure mode this file has, and a legacy host check predates `kind`.
  const legacy = {
    name: "legacy-host-check",
    run: async () => [{ severity: "block", where: "document", message: "the legacy check fired" }],
  } as unknown as Check;

  it("runs it and reports its findings", async () => {
    const layer = createCheckingLayer({ deps: deps(), checks: [legacy] });

    expect(await layer.run(inputFor(GOOD))).toContainEqual({
      severity: "block",
      where: "document",
      message: "the legacy check fired",
      check: "legacy-host-check",
    });
  });

  it("keeps it out of the rubric — a kind-less check is code, not a rule", () => {
    expect(createCheckingLayer({ deps: deps(), checks: [legacy] }).rubric).toEqual([]);
  });
});

describe("a check returning garbage costs its findings, never the build (F9)", () => {
  const returning = (value: unknown): Check =>
    ({ name: "sloppy", run: async () => value } as unknown as Check);

  it("turns a check that returns undefined into one warn", async () => {
    const findings = await createCheckingLayer({ deps: deps(), checks: [returning(undefined)] }).run(inputFor(GOOD));

    expect(findings).toEqual([{
      severity: "warn",
      where: "sloppy",
      message: 'the check "sloppy" did not report a list of findings, so whatever it would have found is missing from this report',
      check: "sloppy",
    }]);
  });

  it("turns a check that returns a non-array into one warn", async () => {
    const findings = await createCheckingLayer({ deps: deps(), checks: [returning({ severity: "block" })] }).run(inputFor(GOOD));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warn");
  });

  it("keeps the well-formed findings and warns about the malformed ones", async () => {
    // Never lose a real block to a neighbour's bad entry.
    const mixed = returning([
      { severity: "block", where: "document", message: "a real finding" },
      { severity: "catastrophe", message: "not a severity" },
      null,
    ]);

    const findings = await createCheckingLayer({ deps: deps(), checks: [mixed] }).run(inputFor(GOOD));

    expect(findings).toContainEqual({ severity: "block", where: "document", message: "a real finding", check: "sloppy" });
    expect(findings).toContainEqual({
      severity: "warn",
      where: "sloppy",
      message: 'the check "sloppy" reported 2 findings in a shape this floor cannot read, so whatever they said is missing from this report',
      check: "sloppy",
    });
  });

  it("passes a finding carrying extra properties through as authored", async () => {
    // Filter, not normalize: the shape is a floor, not a schema, and a host's own
    // check may carry a field for its own reader.
    const extra = returning([{ severity: "warn", where: "document", message: "m", hint: { code: 7 } }]);

    expect(await createCheckingLayer({ deps: deps(), checks: [extra] }).run(inputFor(GOOD)))
      .toEqual([{ severity: "warn", where: "document", message: "m", hint: { code: 7 }, check: "sloppy" }]);
  });

  it("never lets a malformed entry reach a consumer that reads severity", async () => {
    const findings = await createCheckingLayer({ deps: deps(), checks: [returning([undefined])] }).run(inputFor(GOOD));

    for (const finding of findings) {
      expect(["block", "warn"]).toContain(finding.severity);
      expect(typeof finding.message).toBe("string");
    }
  });
});

describe("a broken check costs its findings, never the build", () => {
  it("turns a throwing fact check into exactly one warn and blocks nothing", async () => {
    const layer = createCheckingLayer({
      deps: deps(),
      checks: [{ name: "flaky", kind: "fact", run: async () => { throw new Error("model call timed out"); } }],
    });

    const findings = await layer.run(inputFor(GOOD));

    expect(findings).toEqual([{
      severity: "warn",
      where: "flaky",
      message: 'the check "flaky" failed to run (model call timed out), so whatever it would have found is missing from this report',
      check: "flaky",
    }]);
    expect(findings.filter(({ severity }) => severity === "block")).toEqual([]);
  });

  it("keeps every other check's findings when one throws", async () => {
    const layer = createCheckingLayer({
      deps: deps(),
      checks: [
        { name: "flaky", kind: "fact", run: async () => { throw new Error("boom"); } },
        factCheck("solid", () => [{ severity: "block", where: "document", message: "still reported" }]),
      ],
    });

    const findings = await layer.run(inputFor(GOOD));

    expect(findings).toContainEqual({ severity: "block", where: "document", message: "still reported", check: "solid" });
    expect(findings.some(({ where }) => where === "flaky")).toBe(true);
  });
});

describe("findings are order-independent", () => {
  const one = factCheck("one", () => [{ severity: "warn", where: "one", message: "one ran" }]);
  const two = factCheck("two", () => [{ severity: "block", where: "two", message: "two ran" }]);

  it("reports the same set however the checks were registered", async () => {
    const forward = await createCheckingLayer({ deps: deps(), checks: [one, two] }).run(inputFor(GOOD));
    const backward = await createCheckingLayer({ deps: deps(), checks: [two, one] }).run(inputFor(GOOD));

    const key = (findings: readonly { severity: string; where?: string; message: string }[]): string =>
      [...findings].map((finding) => JSON.stringify(finding)).sort().join("|");
    expect(key(forward)).toBe(key(backward));
  });

  it("shows no check another check's findings", async () => {
    const seen: CheckInput[] = [];
    const nosy = (name: string): Check =>
      ({ name, kind: "fact", run: async (input) => { seen.push(input); return [{ severity: "warn", where: name, message: name }]; } });

    await createCheckingLayer({ deps: deps(), checks: [nosy("a"), nosy("b")] }).run(inputFor(GOOD));

    expect(seen).toHaveLength(2);
    // The input a check receives carries the app and the ask — never findings.
    for (const input of seen) expect(Object.keys(input).sort()).toEqual(["document", "request"]);
  });
});
