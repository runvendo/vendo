/**
 * The island-escape metric row: the three shapes it has to tell apart — the
 * escape (island dominates, no queries, island reads tools), the legitimate
 * data-free utility (island, no queries, NO tools), and a composed app.
 */
import { describe, expect, it } from "vitest";
import { VENDO_APP_FORMAT, VENDO_TREE_FORMAT } from "@vendoai/core";
import type { AppDocument } from "@vendoai/core";
import type { PipelineEvent } from "@vendoai/apps";
import { measureRecord, summarize } from "./metrics";
import type { HostName, RunRecord } from "../runner/types";

const WRITE_TOOLS: Partial<Record<HostName, ReadonlySet<string>>> = {
  maple: new Set(["host_transferMoney"]),
};

const document = (over: Partial<AppDocument> & { componentTools?: Record<string, string[]> }): AppDocument => ({
  id: "app_test",
  format: VENDO_APP_FORMAT,
  name: "App",
  ui: "tree",
  tree: { formatVersion: VENDO_TREE_FORMAT, root: "root", nodes: [{ id: "root", component: "Stack" }] },
  ...over,
} as AppDocument);

const record = (over: {
  document: AppDocument;
  wire: string;
  events?: PipelineEvent[];
  prompt?: string;
}): RunRecord => ({
  id: "20260727-000000-abcd",
  createdAt: "2026-07-27T00:00:00.000Z",
  gitSha: "sha",
  gitDirty: null,
  request: { prompt: over.prompt ?? "prompt", host: "maple", lanes: ["vendo"] },
  lanes: {
    vendo: {
      status: "ok",
      startedAt: 0,
      durationMs: 40_000,
      document: over.document,
      wire: over.wire,
      events: over.events ?? [],
    },
  },
});

describe("measureRecord", () => {
  it("flags the escape: island source dominates, zero queries, island reads host tools", () => {
    const source = "x".repeat(9_000);
    const row = measureRecord(record({
      wire: `<App name="A">${source}</App>`,
      document: document({
        components: { Everything: source },
        componentTools: { Everything: ["host_listTransactions", "host_transferMoney"] },
      }),
    }), WRITE_TOOLS);

    expect(row.islandCount).toBe(1);
    expect(row.queryCount).toBe(0);
    expect(row.islandRatio).toBeGreaterThan(0.9);
    expect(row.zeroQueryIsland).toBe(true);
    expect(row.islandReadsWithoutQueries).toBe(true);
    expect(row.dataFreeUtility).toBe(false);
    expect(row.mutatingIslandTools).toBe(true);
    expect(row.islandToolWrites).toEqual(["host_transferMoney"]);
    expect(row.islandToolReads).toEqual(["host_listTransactions"]);
  });

  it("does not flag the data-free utility: island, zero queries, NO tools reached", () => {
    const row = measureRecord(record({
      wire: "<App name=\"Tip calculator\">…</App>",
      document: document({ components: { TipCalculator: "src" }, componentTools: { TipCalculator: [] } }),
    }), WRITE_TOOLS);

    expect(row.zeroQueryIsland).toBe(true);
    expect(row.islandReadsWithoutQueries).toBe(false);
    expect(row.dataFreeUtility).toBe(true);
    expect(row.mutatingIslandTools).toBe(false);
  });

  it("counts queries, nodes, and pipeline work on a composed app", () => {
    const row = measureRecord(record({
      wire: "<App/>".padEnd(1_000, " "),
      document: document({
        tree: {
          formatVersion: VENDO_TREE_FORMAT,
          root: "root",
          nodes: [{ id: "root", component: "Stack" }, { id: "t", component: "DataTable" }],
          queries: [{ name: "txns", tool: "host_listTransactions" }],
        },
      } as Partial<AppDocument>),
      events: [
        { stage: "full", attempt: 0, valid: false, ms: 1, issues: ["bad binding"] },
        { stage: "repair", rounds: 2, repaired: true, noValidFix: 0, ms: 2 },
        { stage: "full", attempt: 1, valid: true, ms: 3 },
      ],
    }), WRITE_TOOLS);

    expect(row.queryCount).toBe(1);
    expect(row.nodeCount).toBe(2);
    expect(row.islandCount).toBe(0);
    expect(row.islandRatio).toBe(0);
    expect(row.zeroQueryIsland).toBe(false);
    expect(row.fullAttempts).toBe(2);
    expect(row.repairRounds).toBe(2);
    expect(row.validationIssues).toEqual(["bad binding"]);
  });

  it("records a failed lane without inventing shape numbers", () => {
    const row = measureRecord({
      id: "20260727-000001-abce",
      createdAt: "2026-07-27T00:00:01.000Z",
      gitSha: "sha",
      gitDirty: null,
      request: { prompt: "p", host: "cadence", lanes: ["vendo"] },
      lanes: { vendo: { status: "failed", startedAt: 0, durationMs: 5, error: "boom" } },
    });
    expect(row.status).toBe("failed");
    expect(row.error).toBe("boom");
    expect(row.wireChars).toBe(0);
    expect(row.islandRatio).toBe(0);
  });
});

describe("summarize", () => {
  it("rates the escape and the utility separately, over OK apps only", () => {
    const rows = [
      measureRecord(record({
        wire: "y".repeat(1_000),
        document: document({ components: { Big: "y".repeat(900) }, componentTools: { Big: ["host_listTransactions"] } }),
      }), WRITE_TOOLS),
      measureRecord(record({
        wire: "y".repeat(1_000),
        document: document({ components: { Calc: "y".repeat(900) }, componentTools: { Calc: [] } }),
      }), WRITE_TOOLS),
    ];
    const summary = summarize("t", rows);
    expect(summary.ok).toBe(2);
    expect(summary.zeroQueryIsland).toBe(2);
    expect(summary.islandReadsWithoutQueries).toBe(1);
    expect(summary.dataFreeUtility).toBe(1);
    expect(summary.islandRatioOver["0.8"]).toBe(2);
    expect(summary.islandRatioHistogram["(0.8,1]"]).toBe(2);
  });
});
