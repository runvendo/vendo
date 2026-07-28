/**
 * The AI reviewer (generation pipeline rebuild, Task 6): one strict
 * `report_findings` call per finished app, its answer parsed into findings —
 * and every way that call can go wrong parsed into no findings at all, because
 * the reviewer must never be what kills a generated app.
 */
import {
  VENDO_APP_FORMAT,
  compileWire,
  type NormalizedCatalog,
  type ShapeType,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createCheckingLayer } from "./layer.js";
import { reviewerCheck } from "./reviewer.js";
import type { CheckInput } from "./types.js";
import type {
  GeneratedAppDocument,
  GenerationDependencies,
  HostToolInfo,
} from "../generation/engine.js";
import { scriptedLanguageModel, type ScriptedModelCall } from "../testing/scripted-model.js";

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

const deps = (model: GenerationDependencies["model"]): GenerationDependencies =>
  ({ model, catalog, tools, toolShapes });

const documentFrom = (wire: string): GeneratedAppDocument => {
  const compiled = compileWire(wire, { toolShapes });
  return {
    format: VENDO_APP_FORMAT,
    name: compiled.name ?? "Untitled",
    ui: "tree",
    tree: compiled.tree as GeneratedAppDocument["tree"],
  };
};

const inputFor = (wire: string, request = "show me my invoices"): CheckInput =>
  ({ app: documentFrom(wire), request });

const invoicesApp =
  '<App name="Invoices"><Query id="invoices" tool="host_listInvoices"/><Stack gap={12}><Text text="Total: $12,480" variant="heading"/><Table rows={invoices.data}/></Stack></App>';

const samples = {
  invoices: { data: [{ id: "inv_1", client: "Northwind", amountCents: 990_00 }] },
};

const reported = (findings: unknown): { tool: string; input: unknown } =>
  ({ tool: "report_findings", input: { findings } });

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

    const findings = await reviewerCheck(deps(model), samples).run(inputFor(invoicesApp));

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

    await reviewerCheck(deps(model), samples).run(inputFor(invoicesApp, "list my overdue invoices"));

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
    expect(text).toContain("<Table rows={invoices.data}/>");
    expect(text).not.toMatch(/id="n\d/);
    // The truth the literals are judged against.
    expect(text).toContain('invoices: {"data":[{"id":"inv_1","client":"Northwind","amountCents":99000}]}');
  });

  it("returns no findings when the model says nothing and calls no tool", async () => {
    const model = scriptedLanguageModel("I have no comment on this app.");

    const findings = await reviewerCheck(deps(model)).run(inputFor(invoicesApp));

    expect(findings).toEqual([]);
  });

  it("returns no findings when the model call throws, so a broken reviewer never crashes generation", async () => {
    const model = scriptedLanguageModel(() => { throw new Error("529 overloaded"); });

    const findings = await reviewerCheck(deps(model), samples).run(inputFor(invoicesApp));

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
      '<App name="Invoices"><Query id="invoices" tool="host_getInvoices"/><Stack><Table rows={invoices.data}/></Stack></App>',
    ));

    expect(layer.checks.map(({ name }) => name)).toContain("reviewer");
    expect(findings).toContainEqual({
      severity: "block",
      where: '<Button> labeled "Remind client"',
      message: 'the button calls host_listInvoices, which only reads invoices — it sends no reminder; drop the button or say so honestly',
    });
    expect(findings.some(({ where, message }) =>
      where === 'query "invoices"' && message.includes('unknown tool "host_getInvoices"'))).toBe(true);
  });
});
