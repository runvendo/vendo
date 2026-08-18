/**
 * The checking layer (generation pipeline rebuild, Task 3): the plug-in shape
 * every check speaks, the parallel run that flat-merges their findings, and
 * the built-in FACT checks — whose messages must teach (name the real
 * alternative), because a model repairs from them and a human reads them.
 */
import {
  VENDO_APP_FORMAT,
} from "@vendoai/core";
import {
  SCREEN_FILE,
  type AppDocument,
  type NormalizedCatalog,
} from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { screenTypesCheck } from "../../src/server/checking/facts.js";
import { createCheckingLayer } from "../../src/server/checking/layer.js";
import { inlineSourceFile } from "../../src/server/persistence/app-source.js";
import type { Check, CheckInput } from "../../src/server/checking/types.js";
import type { FloorDependencies, HostToolInfo } from "../../src/server/checking/deps.js";
import { scriptedLanguageModel } from "../../src/server/testing/scripted-model.js";

const tools: HostToolInfo[] = [
  {
    name: "host_listInvoices",
    description: "Open invoices",
    risk: "read",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        data: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, client: { type: "string" }, amountCents: { type: "number" } },
            required: ["id", "client", "amountCents"],
            additionalProperties: false,
          },
        },
      },
      required: ["data"],
      additionalProperties: false,
    },
  },
  {
    name: "host_listClients",
    description: "Clients",
    risk: "read",
    inputSchema: { type: "object", properties: {} },
  },
];

const catalog: NormalizedCatalog = [];

const deps = (): FloorDependencies => ({
  model: scriptedLanguageModel(() => "the reviewer is not wired in these cases"),
  catalog,
  tools,
});

/** A stored app as the checks read one: an app IS its `app.tsx`, spelled the way
 *  the row spells it, which is what the compiler half type-checks. */
const screenDocument = (source: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_checking_test",
  name: "Invoices",
  ui: "tree",
  source: { [SCREEN_FILE]: inlineSourceFile(source) },
});

const inputFor = (document: AppDocument, request = "show me my invoices"): CheckInput =>
  ({ document, request });

const cleanApp = screenDocument(`import { Stack, Text, useQuery } from "@vendo/screen";

export default function Invoices() {
  const invoices = useQuery("host_listInvoices");
  return (
    <Stack>
      <Text>{invoices.data.length} invoices</Text>
    </Stack>
  );
}
`);

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

    const layer = createCheckingLayer({ checks: [gated("one"), gated("two")] });
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

    const layer = createCheckingLayer({ checks: [hostCheck] });
    const findings = await layer.run(inputFor(cleanApp, "list my invoices"));

    expect(layer.checks.map(({ name }) => name)).toContain("maple-house-style");
    // Appended, never replacing: the built-in fact check is still registered.
    // `screen-types` (the tsc static half) is NOT a built-in factCheck — it is
    // added only at the floor and the validate door, off the create hot path.
    expect(layer.checks.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "document", "maple-house-style",
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

    const layer = createCheckingLayer({ checks: [exploding] });
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
    const layer = createCheckingLayer();
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
    const layer = createCheckingLayer({ checks: [hostCheck] });
    const findings = await layer.run(inputFor(cleanApp));
    expect(findings).toEqual([{
      severity: "block",
      where: 'node "n2"',
      message: "no money figure without its account.",
      check: "maple-house-rules",
    }]);
  });

  it("stamps the built-in that fired, so the two are now distinguishable", async () => {
    const layer = createCheckingLayer({ checks: [hostCheck] });
    const findings = await layer.run(inputFor({ ...cleanApp, name: "" }));
    const byCheck = new Set(findings.map(({ check }) => check));
    expect(byCheck).toContain("document");
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
    const findings = await createCheckingLayer({ checks: [liar] }).run(inputFor(cleanApp));
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
    const findings = await createCheckingLayer({ checks: [thrower] }).run(inputFor(cleanApp));
    expect(findings).toEqual([{
      severity: "warn",
      where: "explodes",
      message: 'the check "explodes" failed to run (nope), so whatever it would have found is missing from this report',
      check: "explodes",
    }]);
  });
});

describe("built-in fact checks", () => {
  it("blocks a screen naming a component no vocabulary carries — the wired tsc floor", async () => {
    // Prove-it-can-fail for the `screen-types` wiring: an unknown component is a
    // block that carries the check's own name. `screen-types` is the compiler
    // static half — composed at the floor and the validate door (never in the
    // create hot path), so the layer is built the way those gates build it. Drop
    // `screenTypesCheck` from this layer and the finding vanishes.
    const layer = createCheckingLayer({ checks: [screenTypesCheck(deps())] });
    const findings = await layer.run(inputFor(screenDocument(`import { Stack, useQuery } from "@vendo/screen";

export default function Invoices() {
  const invoices = useQuery("host_listInvoices");
  return (
    <Stack>
      <MapleGhostCard valueCents={invoices.data.length} />
    </Stack>
  );
}
`)));

    const finding = findings.find(({ check }) => check === "screen-types");
    expect(finding?.severity).toBe("block");
    expect(finding?.message).toContain('references unknown component "MapleGhostCard"');
  }, 60_000);

  /**
   * A computed value's FIELDS belong to `screen-types` now, not to
   * `expressions-compute`: the gap is real JavaScript, so the screen's own text
   * type-checks against the query's DECLARED result type under the real
   * compiler, and the second bespoke shape walker that used to read the same
   * fields could only disagree with it, so it is gone. The layer is composed the
   * way the two gates that run the compiler half compose it — the floor and the
   * validate door.
   *
   * The seam is real on both ends: the STORED `app.tsx` is what the check reads,
   * verbatim, and tsc reads that same text. Nothing here stubs either side.
   */
  it("names the real fields when a computed value reaches a field the tool shape has not got", async () => {
    const layer = createCheckingLayer({ checks: [screenTypesCheck(deps())] });
    const findings = await layer.run(inputFor(screenDocument(`import { Stack, Stat, useQuery } from "@vendo/screen";

export default function Invoices() {
  const invoices = useQuery("host_listInvoices");
  return (
    <Stack>
      <Stat label="Total" value={invoices.data.reduce((total, row) => total + row.amountCent, 0)} />
    </Stack>
  );
}
`)));

    const finding = findings.find(({ message }) => message.includes('reads field "amountCent"'));
    expect(finding?.check).toBe("screen-types");
    expect(finding?.severity).toBe("block");
    expect(finding?.message).toContain("the real fields are: id, client, amountCents");
  }, 60_000);

  it("blocks a document with no title and says what name is for", async () => {
    const layer = createCheckingLayer();
    const findings = await layer.run({ document: { ...cleanApp, name: "" }, request: "invoices" });

    expect(findings).toContainEqual({
      severity: "block",
      where: "document",
      message: 'must carry a non-empty name="..." attribute',
      check: "document",
    });
  });
});
