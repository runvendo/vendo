/**
 * The AI reviewer (generation pipeline rebuild, Task 6): one strict
 * `report_findings` call per finished app, its answer parsed into findings —
 * and every way that call can go wrong parsed into no findings at all, because
 * the reviewer must never be what kills a generated app.
 */
import {
  VENDO_APP_FORMAT,
  compileWire,
  type AppDocument,
  type AppPlan,
  type NormalizedCatalog,
  type ShapeType,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createCheckingLayer, judgmentRules } from "../../src/checking/layer.js";
import { reviewerCheck } from "../../src/checking/reviewer.js";
import type { Check, CheckInput } from "../../src/checking/types.js";
import type { FloorDependencies, HostToolInfo } from "../../src/checking/deps.js";
import { scriptedLanguageModel, type ScriptedModelCall } from "../../src/testing/scripted-model.js";

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

const documentFrom = (wire: string): AppDocument => {
  const compiled = compileWire(wire, { toolShapes });
  return {
    format: VENDO_APP_FORMAT,
    id: "app_reviewer_test",
    name: compiled.name ?? "Untitled",
    ui: "tree",
    tree: compiled.tree as unknown as AppDocument["tree"],
  } as AppDocument;
};

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

const inputFor = (wire: string, request = "show me my invoices"): CheckInput =>
  ({ document: documentFrom(wire), request });

const invoicesApp =
  '<App name="Invoices"><Query id="invoices" tool="host_listInvoices"/><Stack gap={12}><Text text="Total: $12,480" variant="heading"/><DataTable rows={invoices.data}/></Stack></App>';

const samples = {
  invoices: { data: [{ id: "inv_1", client: "Northwind", amountCents: 990_00 }] },
};

const reported = (findings: unknown): { tool: string; input: unknown } =>
  ({ tool: "report_findings", input: { findings } });

/** A plan that commits to a Friday automation. The runtime's server lane arms it
 *  AFTER the review runs, so the tree legitimately carries no reminder. */
const scheduledPlan = (): AppPlan => ({
  name: "Invoices",
  queries: [{ id: "invoices", tool: "host_listInvoices", input: {} }],
  groups: [{ tab: "Overview", leaves: [{ component: "DataTable", query: "invoices", purpose: "open invoices" }] }],
  server: { kind: "steps", schedule: "every Friday", why: "Chasing overdue invoices happens when nobody has the app open." },
  cannot: [],
});

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
        ? reported([{ severity: "block", where: 'node "n2"', message: "the total does not say which report it came from" }])
        : reported([]);
    });

    const withRule = await factReviewerCheck(deps(readerApplying(CITE_TOTALS)), samples, [CITE_TOTALS])
      .run(inputFor(invoicesApp));
    const withoutRule = await factReviewerCheck(deps(readerApplying(CITE_TOTALS)), samples, [])
      .run(inputFor(invoicesApp));

    expect(withRule).toEqual([{
      severity: "block",
      where: 'node "n2"',
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

  it("sends ONE strict report_findings call carrying the request, the printed app and the sample data", async () => {
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
    // The app as a person sees it: id-free markup, not compiler bookkeeping.
    expect(text).toContain('<Text text="Total: $12,480"');
    expect(text).toContain("<DataTable rows={invoices.data}/>");
    expect(text).not.toMatch(/id="n\d/);
    // The truth the literals are judged against.
    expect(text).toContain('invoices: {"data":[{"id":"inv_1","client":"Northwind","amountCents":99000}]}');
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

    // A query naming a tool the host has not got: one fact finding, alongside
    // whatever the reviewer says.
    const findings = await layer.run(inputFor(
      '<App name="Invoices"><Query id="invoices" tool="host_getInvoices"/><Stack><DataTable rows={invoices.data}/></Stack></App>',
    ));

    expect(layer.checks.map(({ name }) => name)).toContain("reviewer");
    expect(findings).toContainEqual({
      severity: "block",
      where: '<Button> labeled "Remind client"',
      message: 'the button calls host_listInvoices, which only reads invoices — it sends no reminder; drop the button or say so honestly',
      check: "reviewer",
    });
    expect(findings.some(({ where, message }) =>
      where === 'query "invoices"' && message.includes('unknown tool "host_getInvoices"'))).toBe(true);
  });

  /**
   * The false-accusation guard. Away work is armed by the runtime AFTER this
   * review, so a reviewer that only reads the tree would report every scheduled
   * app as having silently dropped its reminder.
   */
  it("is told what the plan already committed to, so away work never reads as dropped", async () => {
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => { calls.push(call); return reported([]); });

    const findings = await factReviewerCheck(deps(model), samples).run({
      ...inputFor(invoicesApp, "show my invoices and remind me every Friday"),
      plan: scheduledPlan(),
    });

    expect(findings).toEqual([]);
    const prompt = JSON.stringify(calls[0]?.prompt ?? "");
    expect(prompt).toContain("ALREADY PLANNED");
    expect(prompt).toContain('kind=\\"steps\\"');
    expect(prompt).toContain("every Friday");
    // And it is told WHY it cannot see it yet.
    expect(prompt).toContain("after this review");
  });

  it("says nothing about a plan when there is no plan to speak of", async () => {
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => { calls.push(call); return reported([]); });

    await factReviewerCheck(deps(model), samples).run(inputFor(invoicesApp));

    expect(JSON.stringify(calls[0]?.prompt ?? "")).not.toContain("ALREADY PLANNED");
  });
});
