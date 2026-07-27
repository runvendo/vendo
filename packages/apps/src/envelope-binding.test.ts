import type { NormalizedCatalog } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { modelEngine } from "./engine.js";
import { scriptedLanguageModel } from "./testing/index.js";

/**
 * Defect 1 regression (unified-try-surface try-venue generation E2E,
 * 2026-07-26 — /tmp/try-genqa-hosted/REPORT.md Issue 1). Root cause: the
 * generation contracts' own worked examples (create.ts, exemplar.ts,
 * sections.ts) taught an assumed `{data:[...]}` response envelope
 * unconditionally, contradicting what the synthetic-fixture executor (and
 * most real route tools) actually return — a BARE ARRAY — and never taught
 * the count()/sum()/avg()/min()/max() reshape aggregates at all, so the
 * model reached for JS `.length` and an invented `groupBy` op instead. Fixed
 * by making the taught pattern shape-driven (never assume an envelope; only
 * follow a field the shape literally names) and teaching the aggregate ops.
 *
 * This pins the wire-compile contract those prompt fixes rely on: a query
 * bound straight to a bare-array-shaped tool (no invented ".data"/".items"
 * property) compiles with zero shape-mismatch issues, and a count() pipe (not
 * ".length" or "groupBy") resolves a Stat's value — the exact pattern the
 * live genqa run needed and the old prompts never taught.
 */
describe("bare-array tool responses bind without an assumed envelope", () => {
  const issuesShape = {
    kind: "array" as const,
    items: {
      kind: "object" as const,
      fields: {
        id: { kind: "string" as const },
        title: { kind: "string" as const },
        priority: { kind: "string" as const },
      },
    },
  };

  const catalog: NormalizedCatalog = [];

  it("a DataTable bound directly to the query (no .data) and a count() Stat compile clean — no shape-mismatch, no invalid-reshape", async () => {
    const wire = [
      '<App name="Issues">',
      '<Query id="issuesList" tool="list_issues"/>',
      '<DataTable rows={issuesList} columns={[{key:"title",label:"Title"},{key:"priority",label:"Priority"}]} emptyState="No issues"/>',
      '<Stat label="Total issues" value={issuesList | count()}/>',
      "</App>",
    ].join("");
    const document = await modelEngine.create(
      { prompt: "table of issues with a total count" },
      {
        model: scriptedLanguageModel(wire),
        catalog,
        tools: [{ name: "list_issues", description: "List issues", risk: "read" }],
        toolShapes: { list_issues: issuesShape },
      } as unknown as Parameters<typeof modelEngine.create>[1],
    );

    expect(document.name).toBe("Issues");
    const table = document.tree.nodes.find((node) => node.component === "DataTable");
    // The rows binding resolves the query's OWN result — no invented ".data"
    // segment past the query name (the shape-mismatch class from the report).
    expect(table?.props?.rows).toEqual({ $path: "/issuesList" });
    const stat = document.tree.nodes.find((node) => node.component === "Stat");
    // A count from a bare list rides the count() aggregate — never ".length"
    // (not indexable on a binding) and never an invented op like "groupBy".
    expect(stat?.props?.value).toMatchObject({
      $path: "/issuesList",
      $reshape: [{ op: "count", args: [] }],
    });
  });

  it("the old assumed-envelope pattern (.data / .length) is what the validator correctly rejects — the class this fix removes from the taught pattern", async () => {
    const wire = [
      '<App name="Issues">',
      '<Query id="issuesList" tool="list_issues"/>',
      '<DataTable rows={issuesList.data} columns={[{key:"title",label:"Title"}]}/>',
      "</App>",
    ].join("");
    await expect(modelEngine.create(
      { prompt: "table of issues" },
      {
        model: scriptedLanguageModel(wire),
        catalog,
        tools: [{ name: "list_issues", description: "List issues", risk: "read" }],
        toolShapes: { list_issues: issuesShape },
        pipeline: { structuredRepair: false },
      } as unknown as Parameters<typeof modelEngine.create>[1],
    )).rejects.toMatchObject({
      detail: expect.arrayContaining([expect.stringContaining("indexes into an array in the tool's response shape")]),
    });
  });
});
