import type { NormalizedCatalog } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { modelEngine } from "./engine.js";
import { scriptedLanguageModel, type ScriptedModelCall } from "./testing/index.js";

/**
 * W3 — the two laws at compile (v3 spec §The design in five lines).
 * Law 1: data-classed props (Kit prop classes + host catalog schemas) must be
 * bindings — hand-typed business data is a compile error routed to repair.
 * Law 2: the tool surface is statically readable — actions name REAL tools
 * and action payloads match the tool's REAL input parameters.
 */

const catalog: NormalizedCatalog = [{
  name: "NetWorthCard",
  description: "Big balance card.",
  propsSchema: z.object({
    valueCents: z.number(),
    series: z.array(z.number()).optional(),
    changeLabel: z.string().optional(),
  }),
  propsJsonSchema: {
    type: "object",
    properties: {
      valueCents: { type: "number", description: "Total balance in integer cents" },
      series: { type: "array", items: { type: "number" } },
      changeLabel: { type: "string" },
    },
    required: ["valueCents"],
    additionalProperties: false,
  },
}];

const tools = [
  { name: "host_metric", description: "Revenue metric", risk: "read" },
  {
    name: "host_send_reminder",
    description: "Send a reminder",
    risk: "write",
    inputSchema: {
      type: "object",
      properties: { invoiceId: { type: "string" }, note: { type: "string" } },
      required: ["invoiceId"],
      additionalProperties: false,
    },
  },
];

const toolShapes = {
  host_metric: {
    kind: "object" as const,
    fields: {
      totalCents: { kind: "number" as const },
      count: { kind: "number" as const },
      rows: {
        kind: "array" as const,
        items: {
          kind: "object" as const,
          fields: {
            id: { kind: "string" as const },
            client: { kind: "string" as const },
            amountCents: { kind: "number" as const },
          },
        },
      },
    },
  },
};

const promptText = (call: ScriptedModelCall): string => call.prompt.map((message) => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text ?? "").join("");
}).join("\n");

const deps = (model: unknown, extra: Record<string, unknown> = {}) => ({
  model,
  catalog,
  tools,
  toolShapes,
  ...extra,
}) as unknown as Parameters<typeof modelEngine.create>[1];

type Nodes = Array<{ id: string; component: string; props?: Record<string, unknown> }>;
const nodes = (document: { tree: unknown }): Nodes => (document.tree as { nodes: Nodes }).nodes;

const isRepairCall = (call: ScriptedModelCall): boolean =>
  promptText(call).includes("locate the failing nodes");

describe("law 1 — data-classed props must be bindings", () => {
  it("rejects literal rows on a Kit data prop and routes the law to repair", async () => {
    const literal = '<App name="Rows"><Query id="metric" tool="host_metric"/><DataTable rows={[{"client":"Acme","amountCents":285000}]}/></App>';
    const bound = '<App name="Rows"><Query id="metric" tool="host_metric"/><DataTable rows={metric.rows}/></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? literal : bound;
    });
    const document = await modelEngine.create(
      { prompt: "Show invoices" },
      deps(model, { pipeline: { structuredRepair: false } }),
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("carries hand-typed LITERAL business data");
    expect(prompts[1]).toContain('\\"rows\\" on <DataTable>');
    expect(nodes(document).at(-1)?.props?.rows).toEqual({ $path: "/metric/rows" });
  });

  it("rejects a literal scalar in a Kit value slot (hand-typed cents)", async () => {
    const literal = '<App name="Cash"><Query id="metric" tool="host_metric"/><Money cents={90000}/></App>';
    const bound = '<App name="Cash"><Query id="metric" tool="host_metric"/><Money cents={metric.totalCents}/></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? literal : bound;
    });
    const document = await modelEngine.create(
      { prompt: "Total balance" },
      deps(model, { pipeline: { structuredRepair: false } }),
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('\\"cents\\" on <Money> carries hand-typed LITERAL business data');
    expect(nodes(document).at(-1)?.props?.cents).toEqual({ $path: "/metric/totalCents" });
  });

  it("rejects literal business data on data-classed HOST catalog props (cents + series)", async () => {
    const literal = '<App name="NW"><Query id="metric" tool="host_metric"/><NetWorthCard valueCents={123456} series={[1,2,3]}/></App>';
    const bound = '<App name="NW"><Query id="metric" tool="host_metric"/><NetWorthCard valueCents={metric.totalCents}/></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? literal : bound;
    });
    await modelEngine.create(
      { prompt: "Net worth" },
      deps(model, { pipeline: { structuredRepair: false } }),
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('\\"valueCents\\" on <NetWorthCard> carries hand-typed LITERAL business data');
    expect(prompts[1]).toContain('\\"series\\" on <NetWorthCard> carries hand-typed LITERAL business data');
  });

  it("keeps copy and config props free (labels, empty states, columns) — one call, no repair", async () => {
    const wire = '<App name="Free"><Query id="metric" tool="host_metric"/><Text text="Overview" variant="heading"/><Badge label="Beta"/><DataTable rows={metric.rows} emptyState="Nothing yet" columns={[{"key":"client"},{"key":"amountCents","format":"money"}]}/></App>';
    let calls = 0;
    const model = scriptedLanguageModel(() => {
      calls += 1;
      return wire;
    });
    const document = await modelEngine.create({ prompt: "Overview" }, deps(model));
    expect(calls).toBe(1);
    expect(nodes(document).some((node) => node.component === "DataTable")).toBe(true);
  });

  it("splices a literal-data fault through the strict structured-repair fix space", async () => {
    const literal = '<App name="Rows"><Query id="metric" tool="host_metric"/><DataTable rows={[{"client":"Acme"}]}/></App>';
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => {
      calls.push(call);
      if (isRepairCall(call)) return { tool: "apply_fixes", input: { fix_0: "/metric/rows" } };
      return literal;
    });
    const document = await modelEngine.create({ prompt: "Show invoices" }, deps(model));
    expect(calls).toHaveLength(2); // one generation + ONE strict repair call
    const table = nodes(document).find((node) => node.component === "DataTable");
    expect(table?.props?.rows).toEqual({ $path: "/metric/rows" });
  });
});

describe("law 2 — actions ground in the real tool surface", () => {
  it("rejects an action naming a tool absent from the registry", async () => {
    const invented = '<App name="Act"><Query id="metric" tool="host_metric"/><DataTable rows={metric.rows}/><Button label="Send reminder" onClick="host_invented"/></App>';
    const real = '<App name="Act"><Query id="metric" tool="host_metric"/><DataTable rows={metric.rows}/><Button label="Send reminder" onClick={{"action":"host_send_reminder","payload":{"invoiceId":{"$path":"/metric/rows/0/id"}}}}/></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? invented : real;
    });
    await modelEngine.create(
      { prompt: "Remind" },
      deps(model, { pipeline: { structuredRepair: false } }),
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("host_invented");
    expect(prompts[1]).toContain("unknown tool");
  });

  it("rejects a payload whose fields are not the tool's real input parameters", async () => {
    const ungrounded = '<App name="Act"><Query id="metric" tool="host_metric"/><Button label="Send reminder" onClick={{"action":"host_send_reminder","payload":{"bogusField":{"$path":"/metric/count"}}}}/></App>';
    const grounded = '<App name="Act"><Query id="metric" tool="host_metric"/><Button label="Send reminder" onClick={{"action":"host_send_reminder","payload":{"invoiceId":{"$path":"/metric/rows/0/id"}}}}/></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? ungrounded : grounded;
    });
    await modelEngine.create(
      { prompt: "Remind" },
      deps(model, { pipeline: { structuredRepair: false } }),
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("bogusField");
    expect(prompts[1]).toContain("invoiceId");
  });

  it("treats a Kit Form like a submit affordance: read-only onSubmit is rejected, missing onSubmit is a dead submit", async () => {
    const readOnly = '<App name="F"><Query id="metric" tool="host_metric"/><Form onSubmit="host_metric" submitLabel="Save"><Input label="Name"/></Form></App>';
    const dead = '<App name="F"><Query id="metric" tool="host_metric"/><Form submitLabel="Save"><Input label="Name"/></Form></App>';
    const honest = '<App name="F"><Query id="metric" tool="host_metric"/><Form onSubmit={{"action":"host_send_reminder","payload":{"invoiceId":{"$path":"/metric/rows/0/id"}}}} submitLabel="Save"><Input label="Name"/></Form></App>';
    for (const bad of [readOnly, dead]) {
      const prompts: string[] = [];
      const model = scriptedLanguageModel((call) => {
        prompts.push(promptText(call));
        return prompts.length === 1 ? bad : honest;
      });
      await modelEngine.create(
        { prompt: "Save form" },
        deps(model, { pipeline: { structuredRepair: false } }),
      );
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toMatch(/submit/i);
    }
  });
});

describe("semantics + domain manifest reach the generation prompt (W3 §Context)", () => {
  it("annotates shape cards with field semantics and states the domain manifest as fact", async () => {
    let captured = "";
    const model = scriptedLanguageModel((call) => {
      captured = promptText(call);
      return '<App name="Tx"><DataTable rows={host_metric({}).rows}/></App>';
    });
    await modelEngine.create({ prompt: "Transactions" }, deps(model, {
      semantics: {
        host_metric: {
          totalCents: { kind: "money", unit: "cents" },
          "rows.amountCents": { kind: "money", unit: "cents" },
        },
      },
      domains: { has: ["accounts", "transactions"], hasNot: ["payroll", "crypto"] },
    }));
    expect(captured).toContain("totalCents: number:money.cents");
    expect(captured).toContain("amountCents: number:money.cents");
    expect(captured).toContain("DATA DOMAINS");
    expect(captured).toContain("This host HAS data for: accounts, transactions.");
    expect(captured).toContain("This host has NO data for: payroll, crypto.");
  });
});

describe("inline tool refs in the production path (W1 Exp1 verdict — adopted)", () => {
  it("accepts inline refs with production (underscore) tool names, minting ONE deduped query; <Query> stays accepted", async () => {
    const wire = '<App name="Tx"><DataTable rows={host_metric({}).rows}/><Stat label="Count" value={host_metric({}).count}/></App>';
    const model = scriptedLanguageModel(wire);
    const document = await modelEngine.create({ prompt: "Transactions" }, deps(model));
    const tree = document.tree as { queries?: Array<{ name: string; tool: string }>; nodes: Nodes };
    expect(tree.queries).toHaveLength(1);
    expect(tree.queries?.[0]?.tool).toBe("host_metric");
    const queryName = tree.queries?.[0]?.name as string;
    const table = tree.nodes.find((node) => node.component === "DataTable");
    const stat = tree.nodes.find((node) => node.component === "Stat");
    expect(table?.props?.rows).toEqual({ $path: `/${queryName}/rows` });
    expect(stat?.props?.value).toEqual({ $path: `/${queryName}/count` });
  });

  it("teaches inline references in the WIRE DIALECT prompt", async () => {
    let captured = "";
    const model = scriptedLanguageModel((call) => {
      captured = promptText(call);
      return '<App name="Tx"><DataTable rows={host_metric({}).rows}/></App>';
    });
    await modelEngine.create({ prompt: "Transactions" }, deps(model));
    expect(captured).toContain("INLINE TOOL REFERENCES");
    expect(captured).toContain("also accepted");
  });
});

describe("law 2 — query inputs are literal JSON (a dependent call cannot execute)", () => {
  it("rejects an inline-ref arg that embeds another query's binding and routes it to repair", async () => {
    // Live-verify finding (Maple P2): the model writes dependent calls like
    // host_listAccountTransactions({accountId: accounts.data.0.id}) — the
    // runtime executes query inputs as literal JSON, so the tool receives an
    // unresolved binding object and the app ships broken.
    const dependent = '<App name="Tx"><DataTable rows={host_send_reminder({invoiceId: metric.rows.0.id}).data}/><Query id="metric" tool="host_metric"/></App>';
    const literal = '<App name="Tx"><Query id="metric" tool="host_metric"/><DataTable rows={metric.rows}/></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? dependent : literal;
    });
    await modelEngine.create(
      { prompt: "Transactions" },
      deps(model, { pipeline: { structuredRepair: false } }),
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("query inputs must be LITERAL JSON");
  });
});

describe("law 1 raw typing — bound field kinds must match the Kit slot", () => {
  it("rejects a string-shaped field bound into Money.cents (pre-formatted money strings fail)", async () => {
    const shapes = {
      host_metric: {
        kind: "object" as const,
        fields: { totalDisplay: { kind: "string" as const }, totalCents: { kind: "number" as const } },
      },
    };
    const wrong = '<App name="Cash"><Query id="metric" tool="host_metric"/><Money cents={metric.totalDisplay}/></App>';
    const right = '<App name="Cash"><Query id="metric" tool="host_metric"/><Money cents={metric.totalCents}/></App>';
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call) => {
      prompts.push(promptText(call));
      return prompts.length === 1 ? wrong : right;
    });
    const document = await modelEngine.create(
      { prompt: "Total" },
      deps(model, { toolShapes: shapes, pipeline: { structuredRepair: false } }),
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("cents");
    expect(nodes(document).at(-1)?.props?.cents).toEqual({ $path: "/metric/totalCents" });
  });
});
