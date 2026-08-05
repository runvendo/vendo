/**
 * The checking layer (generation pipeline rebuild, Task 3): the plug-in shape
 * every check speaks, the parallel run that flat-merges their findings, and
 * the built-in FACT checks — whose messages must teach (name the real
 * alternative), because a model repairs from them and a human reads them.
 */
import {
  VENDO_APP_FORMAT,
  compileWire,
  type AppDocument,
  type NormalizedCatalog,
  type ShapeType,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { screenTypesCheck } from "./facts.js";
import { createCheckingLayer } from "./layer.js";
import type { Check, CheckInput } from "./types.js";
import type { FloorDependencies, HostToolInfo } from "./deps.js";
import { scriptedLanguageModel } from "../testing/scripted-model.js";

const tools: HostToolInfo[] = [
  {
    name: "host_listInvoices",
    description: "Open invoices",
    risk: "read",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "host_listClients",
    description: "Clients",
    risk: "read",
    inputSchema: { type: "object", properties: {} },
  },
];

const toolShapes: Record<string, ShapeType> = {
  host_listInvoices: {
    kind: "object",
    fields: {
      data: {
        kind: "array",
        items: {
          kind: "object",
          fields: {
            id: { kind: "string" },
            client: { kind: "string" },
            amountCents: { kind: "number" },
          },
        },
      },
    },
  },
};

const catalog: NormalizedCatalog = [];

const deps = (): FloorDependencies => ({
  model: scriptedLanguageModel(() => "<App name=\"unused\"/>"),
  catalog,
  tools,
  toolShapes,
});

/** A document as the engine would emit it, compiled from wire so the tree is
 *  the real thing rather than a hand-built lookalike. */
const documentFrom = (wire: string): AppDocument => {
  const compiled = compileWire(wire, { toolShapes });
  return {
    format: VENDO_APP_FORMAT,
    id: "app_checking_test",
    name: compiled.name ?? "Untitled",
    ui: "tree",
    tree: compiled.tree as AppDocument["tree"],
  } as AppDocument;
};

const inputFor = (wire: string, request = "show me my invoices"): CheckInput =>
  ({ document: documentFrom(wire), request });

const cleanApp =
  '<App name="Invoices"><Query id="invoices" tool="host_listInvoices"/><Stack gap={12}><Text text="Invoices" variant="heading"/><Table rows={invoices.data}/></Stack></App>';

/** Blocks every arrival until `count` of them have arrived: a check that gets
 *  past it can only have done so alongside the others. */
const barrier = (count: number): (() => Promise<void>) => {
  let arrived = 0;
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived === count) release();
    await open;
  };
};

describe("checking layer", () => {
  it("runs checks in parallel and flat-merges their findings", async () => {
    const arrive = barrier(2);
    let ran = 0;
    const gated = (name: string): Check => ({
      name,
      kind: "fact",
      run: async () => {
        await arrive();
        ran += 1;
        return [{ severity: "warn", where: name, message: `${name} ran` }];
      },
    });

    const layer = createCheckingLayer({ deps: deps(), checks: [gated("one"), gated("two")] });
    // Serial execution would deadlock on the barrier; reaching an assertion at
    // all is the parallelism proof.
    const findings = await layer.run(inputFor(cleanApp));

    expect(ran).toBe(2);
    // Flat, not nested: one array of findings, whatever each check returned.
    expect(findings).toEqual(expect.arrayContaining([
      { severity: "warn", where: "one", message: "one ran", check: "one" },
      { severity: "warn", where: "two", message: "two ran", check: "two" },
    ]));
    expect(findings.every((finding) => typeof finding.message === "string")).toBe(true);
  });

  it("surfaces a host-registered check's findings alongside the built-ins", async () => {
    const hostCheck: Check = {
      name: "maple-house-style",
      kind: "fact",
      run: async ({ request }) => [{
        severity: "block",
        where: 'node "n2"',
        message: `Maple never shows a bare table for "${request}" — wrap it in a Card`,
      }],
    };

    const layer = createCheckingLayer({ deps: deps(), checks: [hostCheck] });
    const findings = await layer.run(inputFor(cleanApp, "list my invoices"));

    expect(layer.checks.map(({ name }) => name)).toContain("maple-house-style");
    // Appended, never replacing: every built-in fact check is still registered.
    // `screen-types` (the tsc static half) is NOT a built-in factCheck — it is
    // added only at the floor and the validate door, off the create hot path.
    expect(layer.checks.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "document", "tools-exist", "components-exist", "bindings-fit", "expressions-compute",
      "query-inputs-literal", "no-string-interpolation", "maple-house-style",
    ]));
    expect(findings).toContainEqual({
      severity: "block",
      where: 'node "n2"',
      message: 'Maple never shows a bare table for "list my invoices" — wrap it in a Card',
      check: "maple-house-style",
    });
  });

  it("turns a check that throws into a warn finding naming it, never a crash", async () => {
    const exploding: Check = {
      name: "reviewer",
      kind: "fact",
      run: async () => { throw new Error("model call timed out"); },
    };

    const layer = createCheckingLayer({ deps: deps(), checks: [exploding] });
    const findings = await layer.run(inputFor(cleanApp));

    const crash = findings.find(({ where }) => where === "reviewer");
    expect(crash).toEqual({
      severity: "warn",
      where: "reviewer",
      message: 'the check "reviewer" failed to run (model call timed out), so whatever it would have found is missing from this report',
      check: "reviewer",
    });
    // The rest of the layer still reported: a broken check costs its findings,
    // not the run.
    expect(findings.filter(({ where }) => where !== "reviewer")).toEqual([]);
  });

  it("passes a clean app with no findings", async () => {
    const layer = createCheckingLayer({ deps: deps() });
    expect(await layer.run(inputFor(cleanApp))).toEqual([]);
  });
});

/**
 * Check PROVENANCE — architecture design §7's carve-out, "except host-check
 * failures, which only the host can waive via its own policy config".
 *
 * `./review-failure-protocol.test.ts` recorded this as unrepresentable: "Finding
 * carries no check provenance, so a host-check failure cannot be identified".
 * `where` cannot stand in for it — it is the LOCUS (`node "n3" prop "rows"`), it is
 * optional, and a host check is free to write whatever it likes there. So a
 * built-in fact finding and a host's own were the same anonymous object.
 *
 * The layer stamps it, which is the one place that can: it is what invokes every
 * check, so it is the only thing that knows the answer for all of them at once
 * without each check being trusted to self-report honestly.
 */
describe("every finding says which check produced it", () => {
  const hostCheck: Check = {
    name: "maple-house-rules",
    kind: "fact",
    run: async () => [{ severity: "block", where: 'node "n2"', message: "no money figure without its account." }],
  };

  it("stamps a host check's own name, so §7's carve-out is representable", async () => {
    const layer = createCheckingLayer({ deps: deps(), checks: [hostCheck] });
    const findings = await layer.run(inputFor(cleanApp));
    expect(findings).toEqual([{
      severity: "block",
      where: 'node "n2"',
      message: "no money figure without its account.",
      check: "maple-house-rules",
    }]);
  });

  it("stamps the built-in that fired, so the two are now distinguishable", async () => {
    const layer = createCheckingLayer({ deps: deps(), checks: [hostCheck] });
    const findings = await layer.run(inputFor(
      '<App name="Invoices"><Query id="invoices" tool="host_wireMoney"/><Stack><Table rows={invoices.data}/></Stack></App>',
    ));
    const byCheck = new Set(findings.map(({ check }) => check));
    expect(byCheck).toContain("tools-exist");
    expect(byCheck).toContain("maple-house-rules");
    // The whole point: a waive point can now tell them apart.
    expect(findings.filter(({ check }) => check === "maple-house-rules")).toHaveLength(1);
  });

  it("overrides a check that tries to claim someone else's name", async () => {
    // A check is untrusted code. Provenance the layer did not assign is not
    // provenance — it is a check attributing its own finding to a neighbour, which
    // at a waive point is a privilege escalation.
    const liar: Check = {
      name: "liar",
      kind: "fact",
      run: async () => [
        { severity: "block", message: "trust me", check: "document" } as never,
      ],
    };
    const findings = await createCheckingLayer({ deps: deps(), checks: [liar] }).run(inputFor(cleanApp));
    expect(findings).toEqual([{ severity: "block", message: "trust me", check: "liar" }]);
  });

  it("stamps a crash finding too — a check that died is still named", async () => {
    const thrower: Check = {
      name: "explodes",
      kind: "fact",
      run: async () => {
        throw new Error("nope");
      },
    };
    const findings = await createCheckingLayer({ deps: deps(), checks: [thrower] }).run(inputFor(cleanApp));
    expect(findings).toEqual([{
      severity: "warn",
      where: "explodes",
      message: 'the check "explodes" failed to run (nope), so whatever it would have found is missing from this report',
      check: "explodes",
    }]);
  });
});

describe("built-in fact checks", () => {
  it("names the real tools when a query names one the host does not have", async () => {
    const layer = createCheckingLayer({ deps: deps() });
    const findings = await layer.run(inputFor(
      '<App name="Invoices"><Query id="invoices" tool="host_getInvoices"/><Stack><Table rows={invoices.data}/></Stack></App>',
    ));

    const finding = findings.find(({ where }) => where === 'query "invoices"');
    expect(finding?.severity).toBe("block");
    expect(finding?.message).toContain('unknown tool "host_getInvoices"');
    expect(finding?.message).toContain("host_listInvoices, host_listClients");
  });

  it("names the real fields when a binding reaches a field the tool shape has not got", async () => {
    const layer = createCheckingLayer({ deps: deps() });
    const findings = await layer.run(inputFor(
      '<App name="Invoices"><Query id="invoices" tool="host_listInvoices"/><Stack><Text text={invoices.data.0.customer}/></Stack></App>',
    ));

    const finding = findings.find(({ where }) => where.includes('prop "text"'));
    expect(finding?.severity).toBe("block");
    expect(finding?.message).toContain("the real fields are: id, client, amountCents");
  });

  it("blocks a screen naming a component no vocabulary carries — the wired tsc floor", async () => {
    // Prove-it-can-fail for the `screen-types` wiring: an unknown component is a
    // block that carries the check's own name. `screen-types` is the compiler
    // static half — composed at the floor and the validate door (never in the
    // create hot path), so the layer is built the way those gates build it. Drop
    // `screenTypesCheck` from this layer and the finding vanishes.
    const layer = createCheckingLayer({ deps: deps(), checks: [screenTypesCheck(deps())] });
    const findings = await layer.run(inputFor(
      '<App name="Invoices"><Query id="invoices" tool="host_listInvoices"/><Stack><MapleGhostCard valueCents={invoices.data}/></Stack></App>',
    ));

    const finding = findings.find(({ check }) => check === "screen-types");
    expect(finding?.severity).toBe("block");
    expect(finding?.message).toContain('references unknown component "MapleGhostCard"');
  });

  it("names the allowed props when a prewired component is given one it has not got", async () => {
    const layer = createCheckingLayer({ deps: deps() });
    const findings = await layer.run(inputFor(
      '<App name="Invoices"><Query id="invoices" tool="host_listInvoices"/><Stack><Table data={invoices.data}/></Stack></App>',
    ));

    const finding = findings.find(({ message }) => message.includes('unknown prop "data"'));
    expect(finding?.severity).toBe("block");
    expect(finding?.message).toContain("Allowed props: ");
    expect(finding?.message).toContain("rows");
  });

  it("names the real fields when a computed value reaches a field the tool shape has not got", async () => {
    const layer = createCheckingLayer({ deps: deps() });
    const findings = await layer.run(inputFor(
      '<App name="Invoices"><Query id="invoices" tool="host_listInvoices"/><Stack><Stat value={sum(invoices.data, "amountCent")}/></Stack></App>',
    ));

    const finding = findings.find(({ where }) => where.includes('prop "value"'));
    expect(finding?.severity).toBe("block");
    expect(finding?.message).toContain('computes {sum(invoices.data, "amountCent")}');
    expect(finding?.message).toContain("the real fields are: id, client, amountCents");
  });

  it("names the numeric fields when a computed value sums a string field", async () => {
    const layer = createCheckingLayer({ deps: deps() });
    const findings = await layer.run(inputFor(
      '<App name="Invoices"><Query id="invoices" tool="host_listInvoices"/><Stack><Stat value={sum(invoices.data, "client") / count(invoices.data)}/></Stack></App>',
    ));

    const finding = findings.find(({ where }) => where.includes('prop "value"'));
    expect(finding?.severity).toBe("block");
    expect(finding?.message).toContain("sum() needs numeric values");
    expect(finding?.message).toContain("the numeric fields are: amountCents");
  });

  it("reports an unparseable computed value as a sentence naming the bad token", async () => {
    // Hand-set: the wire compiler drops an attribute whose expression does not
    // parse, so a stored/assembled tree is the only way one arrives.
    const layer = createCheckingLayer({ deps: deps() });
    const app = documentFrom(cleanApp);
    const tree = structuredClone(app.tree) as NonNullable<AppDocument["tree"]>;
    const table = tree.nodes.find((node) => node.component === "Table");
    (table as { props?: Record<string, unknown> }).props = { rows: { $expr: 'sum(invoices.data, "amountCents") + * 2' } };
    const findings = await layer.run({ document: { ...app, tree }, request: "invoices" });

    const finding = findings.find(({ where }) => where.includes('prop "rows"'));
    expect(finding?.severity).toBe("block");
    expect(finding?.message).toContain('"*"');
  });

  it("passes a computed value whose fields and types all check out", async () => {
    const layer = createCheckingLayer({ deps: deps() });
    const findings = await layer.run(inputFor(
      '<App name="Invoices"><Query id="invoices" tool="host_listInvoices"/><Stack><Stat value={sum(invoices.data, "amountCents") / count(invoices.data)}/></Stack></App>',
    ));

    expect(findings).toEqual([]);
  });

  it("blocks a document with no title and says what name is for", async () => {
    const layer = createCheckingLayer({ deps: deps() });
    const app = documentFrom(cleanApp);
    const findings = await layer.run({ document: { ...app, name: "" }, request: "invoices" });

    expect(findings).toContainEqual({
      severity: "block",
      where: "document",
      message: 'must carry a non-empty name="..." attribute',
      check: "document",
    });
  });
});
