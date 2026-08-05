/**
 * Filling the plan (generation pipeline rebuild, Task 7). What these tests pin
 * is not "the model wrote good markup" — it is the shape of the machine around
 * it: one call per group, each one blinkered to its own section, fragments
 * landing in their own slots, the dial that stops a burst of calls, reads
 * executed once before anything is built and never a write, and a section that
 * fails staying a section-sized failure.
 */
import { validateTree, type AppDocument, type AppPlan, type NormalizedCatalog, type Tree } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCheckingLayer } from "../checking/layer.js";
import { scriptedLanguageModel, type ScriptedModelCall } from "../testing/index.js";
import { fillPlan } from "./fill.js";
import { skeletonFromPlan } from "./skeleton.js";
import { UNSTORED_APP_ID, type GeneratedPartial, type GenerationDependencies, type HostToolInfo } from "./engine.js";

const catalog: NormalizedCatalog = [{
  name: "MetricCard",
  description: "Use for a single important metric with a short label and display value.",
  propsSchema: z.object({ label: z.string(), value: z.string() }),
  propsJsonSchema: {
    type: "object",
    properties: { label: { type: "string" }, value: { type: "string" } },
    required: ["label", "value"],
    additionalProperties: false,
  },
}];

const tools: HostToolInfo[] = [
  { name: "host_listInvoices", description: "Every invoice with its amount and client.", risk: "read" },
  { name: "host_sendReminder", description: "Email a client about an overdue invoice.", risk: "write" },
];

const INVOICES = [{ id: "in_1", amountCents: 129_900, client: "Northwind" }];

/** The prompt of one scripted call, system and user together — a blinkered
 *  worker is blinkered in BOTH halves (its components ride the system half). */
const promptText = (call: ScriptedModelCall): string => call.prompt.map((message) => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text ?? "").join("");
}).join("\n");

/** A model that answers from the prompt it was given rather than from call
 *  order — workers run concurrently, so call order is not a thing a test may
 *  depend on. */
const answering = (reply: (prompt: string) => string | Promise<string>): GenerationDependencies["model"] =>
  scriptedLanguageModel(async (call) => reply(promptText(call)));

const depsWith = (
  model: GenerationDependencies["model"],
  extra: Partial<GenerationDependencies> = {},
): GenerationDependencies => ({ model, catalog, tools, ...extra });

const plan = (groups: AppPlan["groups"], queries: AppPlan["queries"] = []): AppPlan =>
  ({ name: "Invoices", queries, groups, cannot: [] });

const INVOICE_QUERY = { id: "invoices", tool: "host_listInvoices", input: { limit: 50 } };

const TWO_GROUPS = plan([
  {
    tab: "Overview",
    title: "Health",
    leaves: [{ component: "MetricCard", query: "invoices", purpose: "GROUP0 the total outstanding across every open invoice" }],
  },
  {
    tab: "Overdue",
    leaves: [{ component: "Table", query: "invoices", purpose: "GROUP1 the overdue invoices, worst first" }],
  },
], [INVOICE_QUERY]);

const METRIC = '<MetricCard label="Outstanding" value={sum(invoices, "amountCents")}/>';
const TABLE = '<Table columns={["id", "client"]} rows={invoices}/>';

/** The fragment each group's worker writes, chosen by the purpose in its own
 *  prompt (the only thing a worker sees of the plan). */
const fragmentFor = (prompt: string): string => prompt.includes("GROUP0") ? METRIC : TABLE;

const node = (tree: Tree, id: string) => tree.nodes.find((candidate) => candidate.id === id);
const treeOf = (document: { tree?: unknown }): Tree => document.tree as Tree;

const readingQueries = () => {
  const calls: string[] = [];
  return {
    calls,
    runQuery: async (query: { id: string; tool: string }) => {
      calls.push(query.tool);
      return INVOICES;
    },
  };
};

describe("fillPlan", () => {
  it("makes ONE call per group, and each worker's prompt is blinkered to its own section", async () => {
    const prompts: string[] = [];
    const deps = depsWith(answering((prompt) => {
      prompts.push(prompt);
      return fragmentFor(prompt);
    }));
    const { runQuery } = readingQueries();

    await fillPlan(TWO_GROUPS, skeletonFromPlan(TWO_GROUPS), deps, { runQuery });

    expect(prompts).toHaveLength(2);
    const overview = prompts.find((prompt) => prompt.includes("GROUP0")) as string;
    const overdue = prompts.find((prompt) => prompt.includes("GROUP1")) as string;
    // Its own purpose, its own component's docs, and its query's REAL rows.
    expect(overview).toContain("GROUP0 the total outstanding across every open invoice");
    expect(overview).toContain("MetricCard");
    expect(overview).toContain("Northwind");
    expect(overview).toContain("host_listInvoices");
    // And nothing whatsoever about the other group.
    expect(overview).not.toContain("GROUP1");
    expect(overview).not.toContain("Table");
    expect(overdue).not.toContain("GROUP0");
    expect(overdue).not.toContain("MetricCard");
  });

  it("splices each group's fragment into ITS slot, and shows the app growing", async () => {
    const partials: GeneratedPartial[] = [];
    const deps = depsWith(answering(fragmentFor), {
      onPartial: (partial) => { partials.push(structuredClone(partial) as GeneratedPartial); },
    });
    const { runQuery } = readingQueries();

    const result = await fillPlan(TWO_GROUPS, skeletonFromPlan(TWO_GROUPS), deps, { runQuery });

    const tree = treeOf(result.document);
    expect(validateTree(tree).ok).toBe(true);
    expect(result.findings).toEqual([]);
    // Each slot container survived and now holds that worker's nodes, named
    // under the slot so two workers minting "metriccard-1" cannot collide.
    expect(node(tree, "group-0-body")?.children).toEqual(["group-0-body-metriccard-1"]);
    expect(node(tree, "group-1-body")?.children).toEqual(["group-1-body-table-1"]);
    expect(node(tree, "group-0-body-metriccard-1")).toMatchObject({
      component: "MetricCard",
      source: "host",
      props: { label: "Outstanding" },
    });
    expect(node(tree, "group-1-body-table-1")).toMatchObject({ component: "Table" });
    // Not one pending placeholder is left standing.
    expect(tree.nodes.filter((candidate) => candidate.props?.pending === true)).toEqual([]);
    // The screen saw each section land, one at a time.
    expect(partials).toHaveLength(2);
    expect(partials.map((partial) => partial.tree.nodes.filter((candidate) => candidate.props?.pending === true).length))
      .toEqual([1, 0]);
  });

  it("carries the plan's display hint on every partial, and nothing when the plan declared none", async () => {
    const partialsFor = async (source: AppPlan): Promise<GeneratedPartial[]> => {
      const partials: GeneratedPartial[] = [];
      const deps = depsWith(answering(fragmentFor), {
        onPartial: (partial) => { partials.push(structuredClone(partial) as GeneratedPartial); },
      });
      await fillPlan(source, skeletonFromPlan(source), deps, readingQueries());
      return partials;
    };

    // The in-process emitter is the twin of the harness render seam, so the
    // posture has to ride the same field on both (redesign spec §5).
    const staged = await partialsFor({ ...TWO_GROUPS, display: "stage" });
    expect(staged.map((partial) => partial.display)).toEqual(["stage", "stage"]);

    const plain = await partialsFor(TWO_GROUPS);
    for (const partial of plain) expect(partial).not.toHaveProperty("display");
  });

  it("respects the concurrency dial — never more than N workers in flight", async () => {
    const groups: AppPlan["groups"] = [0, 1, 2, 3].map((index) => ({
      tab: `Tab${index}`,
      leaves: [{ component: "Table", query: "invoices", purpose: `GROUP${index} rows` }],
    }));
    const four = plan(groups, [INVOICE_QUERY]);
    let inFlight = 0;
    let peak = 0;
    const deps = depsWith(answering(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      inFlight -= 1;
      return TABLE;
    }));
    const { runQuery } = readingQueries();

    const result = await fillPlan(four, skeletonFromPlan(four), deps, { runQuery, concurrency: 2 });

    expect(peak).toBe(2);
    expect(result.findings).toEqual([]);
    for (const index of [0, 1, 2, 3]) {
      expect(node(treeOf(result.document), `group-${index}-body`)?.children)
        .toEqual([`group-${index}-body-table-1`]);
    }
  });

  it("never executes a mutating tool at plan time, and says why that section has no rows", async () => {
    const withWrite = plan([
      { tab: "Overview", leaves: [{ component: "MetricCard", query: "invoices", purpose: "GROUP0 total" }] },
      { tab: "Chase", leaves: [{ component: "Table", query: "reminders", purpose: "GROUP1 reminders sent" }] },
    ], [INVOICE_QUERY, { id: "reminders", tool: "host_sendReminder", input: {} }]);
    const deps = depsWith(answering(fragmentFor));
    const { calls, runQuery } = readingQueries();

    const result = await fillPlan(withWrite, skeletonFromPlan(withWrite), deps, { runQuery });

    expect(calls).toEqual(["host_listInvoices"]);
    expect(Object.keys(result.queryResults)).toEqual(["invoices"]);
    expect(result.findings).toEqual([{
      severity: "warn",
      where: 'query "reminders"',
      message: expect.stringContaining('names tool "host_sendReminder", which is not a read'),
    }]);
  });

  it("feeds a fact finding back to the same worker, and splices the fixed fragment", async () => {
    const one = plan([TWO_GROUPS.groups[0] as AppPlan["groups"][number]], [INVOICE_QUERY]);
    const prompts: string[] = [];
    const deps = depsWith(answering((prompt) => {
      prompts.push(prompt);
      // First pass: the metric has no value at all — a fact, not a taste.
      if (!prompt.includes("WHAT IS WRONG WITH IT")) return '<MetricCard label="Outstanding"/>';
      return `<Edit><Old><MetricCard label="Outstanding"/></Old><New>${METRIC}</New></Edit>`;
    }));
    const { runQuery } = readingQueries();

    const result = await fillPlan(one, skeletonFromPlan(one), deps, { runQuery });

    expect(prompts).toHaveLength(2);
    // The finding reached the worker as an instruction, with its locus.
    expect(prompts[1]).toContain('props invalid for host component "MetricCard"');
    expect(prompts[1]).toContain('<MetricCard label="Outstanding"/>');
    expect(result.findings).toEqual([]);
    const tree = treeOf(result.document);
    expect(node(tree, "group-0-body")?.children).toEqual(["group-0-body-metriccard-1"]);
    expect(node(tree, "group-0-body-metriccard-1")?.props).toMatchObject({ label: "Outstanding" });
  });

  it("turns a section that fails both fix-it rounds into an honest note, and the rest of the app stands", async () => {
    let fixTurns = 0;
    const deps = depsWith(answering((prompt) => {
      if (prompt.includes("GROUP1")) return TABLE;
      if (!prompt.includes("WHAT IS WRONG WITH IT")) return '<MetricCard label="A"/>';
      // Two real edits that change the label and never supply the value: the
      // worker is trying and failing, which is the case this covers.
      fixTurns += 1;
      return prompt.includes('label="B"')
        ? '<Edit><Old>label="B"</Old><New>label="C"</New></Edit>'
        : '<Edit><Old>label="A"</Old><New>label="B"</New></Edit>';
    }));
    const { runQuery } = readingQueries();

    const result = await fillPlan(TWO_GROUPS, skeletonFromPlan(TWO_GROUPS), deps, { runQuery });

    expect(fixTurns).toBe(2);
    const tree = treeOf(result.document);
    // The failed section says so where it stood — no shimmering leftovers.
    expect(node(tree, "group-0-body")?.children).toEqual(["group-0-body-failed"]);
    expect(node(tree, "group-0-body-failed")).toEqual({
      id: "group-0-body-failed",
      component: "Text",
      source: "prewired",
      props: { text: "This section could not be built — retry the edit." },
    });
    expect(tree.nodes.some((candidate) => candidate.props?.pending === true)).toBe(false);
    // ONE warn, naming the section and what was still wrong.
    expect(result.findings).toEqual([{
      severity: "warn",
      where: 'group "Health"',
      message: expect.stringContaining("could not be built after 2 fix-it attempts"),
    }]);
    // THE ISOLATION: the other group's fragment is untouched, the tab chrome
    // still stands, and no fact check trips on what the failure left behind.
    expect(node(tree, "group-1-body")?.children).toEqual(["group-1-body-table-1"]);
    expect(node(tree, "tabs")?.props?.tabs).toEqual([
      { value: "Overview", label: "Overview" },
      { value: "Overdue", label: "Overdue" },
    ]);
    const checked = await createCheckingLayer({ deps }).run({
      document: { ...result.document, id: UNSTORED_APP_ID } as AppDocument,
      request: "invoices",
    });
    expect(checked).toEqual([]);
  });

  it("returns what the plan's queries read, so the app's first open reuses it", async () => {
    const deps = depsWith(answering(fragmentFor));
    const { calls, runQuery } = readingQueries();

    const result = await fillPlan(TWO_GROUPS, skeletonFromPlan(TWO_GROUPS), deps, { runQuery });

    expect(result.queryResults).toEqual({ invoices: INVOICES });
    // Once for the whole build, however many groups read it.
    expect(calls).toEqual(["host_listInvoices"]);
  });
});
