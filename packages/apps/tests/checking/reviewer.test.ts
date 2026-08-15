/**
 * The AI reviewer (generation pipeline rebuild, Task 6): one strict
 * `report_findings` call per finished app, its answer parsed into findings —
 * and every way that call can go wrong parsed into no findings at all, because
 * the reviewer must never be what kills a generated app.
 */
import {
  VENDO_APP_FORMAT,
  type ShapeType,
} from "@vendoai/core";
import {
  SCREEN_FILE,
  type AppDocument,
  type NormalizedCatalog,
} from "../../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createCheckingLayer, judgmentRules } from "../../src/server/checking/layer.js";
import { reviewerCheck } from "../../src/server/checking/reviewer.js";
import { inlineSourceFile } from "../../src/server/persistence/app-source.js";
import type { Check, CheckInput } from "../../src/server/checking/types.js";
import type { FloorDependencies, HostToolInfo } from "../../src/server/checking/deps.js";
import { scriptedLanguageModel, type ScriptedModelCall } from "../../src/server/testing/scripted-model.js";

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

const deps = (model: FloorDependencies["model"]): FloorDependencies =>
  ({ model, catalog, tools, toolShapes });

/** The app the reviewer judges: its `app.tsx`, spelled exactly as the row spells
 *  it. The reviewer reads the STORED screen and nothing else. */
const documentFrom = (source: string): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_reviewer_test",
  name: "Invoices",
  ui: "tree",
  source: { [SCREEN_FILE]: inlineSourceFile(source) },
});

/**
 * `reviewerCheck` is declared as the `Check` UNION, and only the fact half has
 * `run` (the judgment half is a rule string). The reviewer is always the fact
 * half; narrow once here so no case below needs a cast — and so this stops
 * compiling the day that stops being true.
 */
const factReviewerCheck = (...args: Parameters<typeof reviewerCheck>): Extract<Check, { run: unknown }> => {
  const check = reviewerCheck(...args);
  if (!("run" in check)) throw new Error("reviewerCheck is no longer a fact check");
  return check;
};

const inputFor = (source: string, request = "show me my invoices"): CheckInput =>
  ({ document: documentFrom(source), request });

const invoicesApp = `import { DataTable, Stack, Text, useQuery } from "@vendo/screen";

export default function Invoices() {
  const invoices = useQuery("host_listInvoices");
  return (
    <Stack gap={12}>
      <Text text="Total: $12,480" variant="heading" />
      <DataTable rows={invoices.data} columns={[{ key: "client" }]} />
    </Stack>
  );
}
`;

const samples = {
  invoices: { data: [{ id: "inv_1", client: "Northwind", amountCents: 990_00 }] },
};

const reported = (findings: unknown): { tool: string; input: unknown } =>
  ({ tool: "report_findings", input: { findings } });

describe("host and pack judgment rules reach the reviewer (F2)", () => {
  const CITE_TOTALS = "Every total on screen has to say which report it came from.";
  const NO_UNATTENDED = "Scheduled work must never move money, message a person, or delete anything.";

  it("appends each rule to the rubric as its own line, never concatenated", async () => {
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => { calls.push(call); return reported([]); });

    await factReviewerCheck(deps(model), samples, [CITE_TOTALS, NO_UNATTENDED]).run(inputFor(invoicesApp));

    const system = String(calls[0]?.prompt?.[0]?.content ?? JSON.stringify(calls[0]?.prompt));
    expect(system).toContain(CITE_TOTALS);
    expect(system).toContain(NO_UNATTENDED);
    // Separate lines: a joined blob reads as one garbled rule.
    expect(system).toContain(`- ${CITE_TOTALS}\n- ${NO_UNATTENDED}`);
  });

  it("says nothing about extra rules when no pack contributed one", async () => {
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => { calls.push(call); return reported([]); });

    await factReviewerCheck(deps(model), samples, []).run(inputFor(invoicesApp));

    const system = String(calls[0]?.prompt?.[0]?.content ?? "");
    expect(system).not.toMatch(/ALSO REJECT/);
  });

  it("changes the verdict: the SAME app blocks only when the rule is in the prompt", async () => {
    // A reader that applies the rule it was given. Same app, same data — the
    // only difference is whether the rubric carried the rule, so a finding here
    // is the rule doing work rather than a scripted constant.
    const readerApplying = (rule: string) => scriptedLanguageModel((call) => {
      const system = String(call.prompt?.[0]?.content ?? "");
      return system.includes(rule)
        ? reported([{ severity: "block", where: '<Text> labeled "Total: $12,480"', message: "the total does not say which report it came from" }])
        : reported([]);
    });

    const withRule = await factReviewerCheck(deps(readerApplying(CITE_TOTALS)), samples, [CITE_TOTALS])
      .run(inputFor(invoicesApp));
    const withoutRule = await factReviewerCheck(deps(readerApplying(CITE_TOTALS)), samples, [])
      .run(inputFor(invoicesApp));

    expect(withRule).toEqual([{
      severity: "block",
      where: '<Text> labeled "Total: $12,480"',
      message: "the total does not say which report it came from",
    }]);
    expect(withoutRule).toEqual([]);
  });

  it("carries the rules a pack contributed through the composed floor, end to end", async () => {
    // The real wiring: judgment checks go in as `Pack.checks`, the floor hands
    // the reviewer exactly the rules it derived, and nothing runs them as code.
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => { calls.push(call); return reported([]); });
    const packChecks = [
      { name: "cite-totals", kind: "judgment" as const, rule: CITE_TOTALS },
      { name: "unattended-irreversibility", kind: "judgment" as const, rule: NO_UNATTENDED },
    ];
    const layer = createCheckingLayer({
      deps: deps(model),
      checks: [reviewerCheck(deps(model), samples, judgmentRules(packChecks)), ...packChecks],
    });

    await layer.run(inputFor(invoicesApp));

    expect(layer.rubric).toEqual([CITE_TOTALS, NO_UNATTENDED]);
    const system = String(calls[0]?.prompt?.[0]?.content ?? "");
    expect(system).toContain(CITE_TOTALS);
    expect(system).toContain(NO_UNATTENDED);
  });
});

describe("the seat the reviewer's one model call rides", () => {
  it("spends the REVIEW model when the floor carries one, and `model` when it does not", async () => {
    // Judging a finished screen against its own rows is a reading job, so the
    // deployment hands the floor the family's fast pick. Two recorders is what
    // makes this a real assertion: which one was asked is the whole fact.
    const writerCalls: ScriptedModelCall[] = [];
    const reviewCalls: ScriptedModelCall[] = [];
    const writer = scriptedLanguageModel((call) => { writerCalls.push(call); return reported([]); });
    const reviewModel = scriptedLanguageModel((call) => { reviewCalls.push(call); return reported([]); });

    await factReviewerCheck({ ...deps(writer), reviewModel }, samples).run(inputFor(invoicesApp));
    expect(reviewCalls).toHaveLength(1);
    expect(writerCalls).toHaveLength(0);

    // No review seat — a host composing this block itself — and it rides `model`,
    // exactly as it always did.
    await factReviewerCheck(deps(writer), samples).run(inputFor(invoicesApp));
    expect(writerCalls).toHaveLength(1);
    expect(reviewCalls).toHaveLength(1);
  });
});

describe("the AI reviewer", () => {
  it("parses the reported findings and returns them as Finding[]", async () => {
    const model = scriptedLanguageModel(() => reported([
      {
        severity: "block",
        where: '<Text> labeled "Total: $12,480"',
        message: "the total is hand-typed; the invoices query returns amountCents — sum that instead",
      },
      {
        severity: "warn",
        where: "document",
        message: "nothing here answers which invoices are overdue, which the ask named",
      },
    ]));

    const findings = await factReviewerCheck(deps(model), samples).run(inputFor(invoicesApp));

    expect(findings).toEqual([
      {
        severity: "block",
        where: '<Text> labeled "Total: $12,480"',
        message: "the total is hand-typed; the invoices query returns amountCents — sum that instead",
      },
      {
        severity: "warn",
        where: "document",
        message: "nothing here answers which invoices are overdue, which the ask named",
      },
    ]);
  });

  it("sends ONE strict report_findings call carrying the request, the stored screen and the sample data", async () => {
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => {
      calls.push(call);
      return reported([]);
    });

    await factReviewerCheck(deps(model), samples).run(inputFor(invoicesApp, "list my overdue invoices"));

    expect(calls).toHaveLength(1);
    const call = calls[0] as ScriptedModelCall;
    const tool = call.tools?.[0] as { name?: string; strict?: boolean; inputSchema?: unknown };
    expect(tool.name).toBe("report_findings");
    expect(tool.strict).toBe(true);
    const schema = tool.inputSchema as {
      additionalProperties: boolean;
      required: string[];
      properties: {
        findings: { type: string; items: { additionalProperties: boolean; required: string[]; properties: { severity: { enum: string[] } } } };
      };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["findings"]);
    expect(schema.properties.findings.type).toBe("array");
    expect(schema.properties.findings.items.additionalProperties).toBe(false);
    expect(schema.properties.findings.items.required).toEqual(["severity", "where", "message"]);
    expect(schema.properties.findings.items.properties.severity.enum).toEqual(["block", "warn"]);

    const text = call.prompt.map((message) => typeof message.content === "string"
      ? message.content
      : message.content.map((part) => part.text ?? "").join("")).join("\n");
    // The ask, verbatim.
    expect(text).toContain("USER_REQUEST: list my overdue invoices");
    // The app as its author wrote it: the whole `app.tsx`, labelled and verbatim.
    expect(text).toContain(`APP (${SCREEN_FILE}):\n${invoicesApp}`);
    // The truth the literals are judged against.
    expect(text).toContain('invoices: {"data":[{"id":"inv_1","client":"Northwind","amountCents":99000}]}');
  });

  it("says nothing at all about an app that carries no screen", async () => {
    // The `document` fact check reports a document with nothing in it; the
    // reviewer stays quiet instead of judging rubble.
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => { calls.push(call); return reported([]); });

    const findings = await factReviewerCheck(deps(model), samples).run({
      document: { format: VENDO_APP_FORMAT, id: "app_reviewer_test", name: "Invoices", ui: "tree" },
      request: "show me my invoices",
    });

    expect(findings).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("returns no findings when the model says nothing and calls no tool", async () => {
    const model = scriptedLanguageModel("I have no comment on this app.");

    const findings = await factReviewerCheck(deps(model)).run(inputFor(invoicesApp));

    expect(findings).toEqual([]);
  });

  it("returns no findings when the model call throws, so a broken reviewer never crashes generation", async () => {
    const model = scriptedLanguageModel(() => { throw new Error("529 overloaded"); });

    const findings = await factReviewerCheck(deps(model), samples).run(inputFor(invoicesApp));

    expect(findings).toEqual([]);
  });

  it("flows its findings through createCheckingLayer alongside the fact checks", async () => {
    const model = scriptedLanguageModel(() => reported([{
      severity: "block",
      where: '<Button> labeled "Remind client"',
      message: 'the button calls host_listInvoices, which only reads invoices — it sends no reminder; drop the button or say so honestly',
    }]));
    const layer = createCheckingLayer({ deps: deps(model), checks: [reviewerCheck(deps(model), samples)] });

    // An app with no title: one fact finding, alongside whatever the reviewer says.
    const findings = await layer.run({
      document: { ...documentFrom(invoicesApp), name: "" },
      request: "show me my invoices",
    });

    expect(layer.checks.map(({ name }) => name)).toContain("reviewer");
    expect(findings).toContainEqual({
      severity: "block",
      where: '<Button> labeled "Remind client"',
      message: 'the button calls host_listInvoices, which only reads invoices — it sends no reminder; drop the button or say so honestly',
      check: "reviewer",
    });
    expect(findings.some(({ check, message }) =>
      check === "document" && message.includes('non-empty name="..."'))).toBe(true);
  });

  it("reads a caller's own rendering when it has a truer one than the stored screen", async () => {
    // `validate` holds the source AND what the queries really returned, so it
    // builds the block itself (`reviewComponentScreenInput`) — and what it hands
    // over is what the reviewer reads, with no second header bolted on.
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => { calls.push(call); return reported([]); });

    await factReviewerCheck(deps(model), samples, [], "SCREEN AS THE CALLER RENDERED IT").run(inputFor(invoicesApp));

    const text = JSON.stringify(calls[0]?.prompt ?? "");
    expect(text).toContain("SCREEN AS THE CALLER RENDERED IT");
    expect(text).not.toContain(`APP (${SCREEN_FILE})`);
  });
});
