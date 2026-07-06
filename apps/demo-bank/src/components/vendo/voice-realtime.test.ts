import { describe, expect, it } from "vitest";
import { replayRegistry } from "@vendoai/shell";
import type { GeneratedPayload } from "@vendoai/core";
import { __voiceTesting } from "./voice-realtime";

const { tableView, recordResult } = __voiceTesting;

const COLUMNS = [
  { key: "merchant", label: "Merchant" },
  { key: "amount", label: "Amount" },
];
const RAW = {
  ok: true,
  data: { transactions: [{ merchant: "Blue Bottle", amount: 650, id: "t1" }] },
};

describe("voice refreshable views (spec §3)", () => {
  it("builds a DATA-BOUND payload with queries when source matches the cache", () => {
    replayRegistry.register("listTransactions", async () => RAW);
    recordResult("listTransactions", { month: "march" }, RAW);
    const node = tableView({
      title: "March",
      columns: COLUMNS,
      rows: RAW.data.transactions,
      source: { tool: "listTransactions", input: { month: "march" }, rowsPath: "/data/transactions" },
    });
    const payload = (node as { payload: GeneratedPayload }).payload;
    expect(payload.queries).toEqual([
      { path: "/source", tool: "listTransactions", input: { month: "march" } },
    ]);
    expect((payload.data as { source: unknown }).source).toEqual(RAW);
    const table = payload.nodes.find((n) => n.component === "Table");
    expect(table?.props?.rows).toEqual({ $path: "/source/data/transactions" });
  });

  it("degrades to a snapshot when the source is unmatched, unreplayable, or misshapen", () => {
    // unmatched input
    const unmatched = tableView({
      columns: COLUMNS,
      rows: RAW.data.transactions,
      source: { tool: "listTransactions", input: { month: "april" }, rowsPath: "/data/transactions" },
    });
    // tool not in the replay registry
    recordResult("createOrder", {}, RAW);
    const unreplayable = tableView({
      columns: COLUMNS,
      rows: RAW.data.transactions,
      source: { tool: "createOrder", input: {}, rowsPath: "/data/transactions" },
    });
    // rowsPath pointing at a non-array
    const misshapen = tableView({
      columns: COLUMNS,
      rows: RAW.data.transactions,
      source: { tool: "listTransactions", input: { month: "march" }, rowsPath: "/ok" },
    });
    // columns whose keys the raw rows don't carry
    const wrongColumns = tableView({
      columns: [{ key: "nope", label: "Nope" }],
      rows: [{ nope: 1 }],
      source: { tool: "listTransactions", input: { month: "march" }, rowsPath: "/data/transactions" },
    });
    for (const node of [unmatched, unreplayable, misshapen, wrongColumns]) {
      const payload = (node as { payload: GeneratedPayload }).payload;
      expect(payload.queries).toBeUndefined();
      expect(payload.data).toBeUndefined();
      const table = payload.nodes.find((n) => n.component === "Table");
      expect(Array.isArray(table?.props?.rows)).toBe(true); // literal rows kept
    }
  });

  it("no source at all keeps today's exact snapshot behavior", () => {
    const node = tableView({ columns: COLUMNS, rows: [{ merchant: "X", amount: 1 }] });
    const payload = (node as { payload: GeneratedPayload }).payload;
    expect(payload.queries).toBeUndefined();
  });
});

describe("review fixes (PR #41 triage)", () => {
  it("accepts an EMPTY result as a valid refreshable declaration", () => {
    const emptyRaw = { ok: true, data: { transactions: [] } };
    replayRegistry.register("listTransactions", async () => emptyRaw);
    recordResult("listTransactions", { month: "may" }, emptyRaw);
    const node = tableView({
      columns: COLUMNS,
      rows: [],
      source: { tool: "listTransactions", input: { month: "may" }, rowsPath: "/data/transactions" },
    });
    const payload = (node as { payload: GeneratedPayload }).payload;
    expect(payload.queries).toEqual([
      { path: "/source", tool: "listTransactions", input: { month: "may" } },
    ]);
  });

  it("matches source inputs regardless of key order (stable cache key)", () => {
    recordResult("listTransactions", { category: "dining", limit: 10 }, RAW);
    const node = tableView({
      columns: COLUMNS,
      rows: RAW.data.transactions,
      source: {
        tool: "listTransactions",
        input: { limit: 10, category: "dining" }, // reversed order
        rowsPath: "/data/transactions",
      },
    });
    const payload = (node as { payload: GeneratedPayload }).payload;
    expect(payload.queries?.[0]?.tool).toBe("listTransactions");
  });

  it("renders titles on the Text prop the primitive actually reads", () => {
    const node = tableView({ title: "March", columns: COLUMNS, rows: [{ merchant: "X", amount: 1 }] });
    const payload = (node as { payload: GeneratedPayload }).payload;
    const titleNode = payload.nodes.find((n) => n.component === "Text");
    expect(titleNode?.props).toEqual({ text: "March" });
  });
});

describe("live voice check fixes (real Maple row shapes)", () => {
  // The REAL listTransactions rows: scalar display fields + nested extras.
  const REAL_ROWS = [
    {
      id: "txn_0135",
      merchant: "Spotify",
      amount: -1199,
      category: "subscriptions",
      statusTimeline: [{ state: "Posted", at: "2026-07-04T13:00:00.000Z" }],
    },
  ];
  const REAL_RAW = { status: 200, ok: true, data: { data: REAL_ROWS } };

  it("binds when declared columns are scalar, even though rows carry nested fields", () => {
    replayRegistry.register("listTransactions", async () => REAL_RAW);
    recordResult("listTransactions", { limit: 40 }, REAL_RAW);
    const node = tableView({
      columns: [
        { key: "merchant", label: "Merchant" },
        { key: "amount", label: "Amount" },
      ],
      rows: REAL_ROWS,
      source: { tool: "listTransactions", input: { limit: 40 }, rowsPath: "/data/data" },
    });
    const payload = (node as { payload: GeneratedPayload }).payload;
    expect(payload.queries?.[0]?.tool).toBe("listTransactions");
  });

  it("degrades to snapshot when a DECLARED column is a nested value", () => {
    recordResult("listTransactions", { limit: 41 }, REAL_RAW);
    const node = tableView({
      columns: [{ key: "statusTimeline", label: "Status" }],
      rows: [{ statusTimeline: "Posted" }],
      source: { tool: "listTransactions", input: { limit: 41 }, rowsPath: "/data/data" },
    });
    const payload = (node as { payload: GeneratedPayload }).payload;
    expect(payload.queries).toBeUndefined();
  });
});

describe("heterogeneous rows (PR #43 review P1)", () => {
  it("degrades to snapshot when a LATER row has a nested value for a declared column", () => {
    const mixed = {
      ok: true,
      data: {
        data: [
          { merchant: "A", status: "posted" },
          { merchant: "B", status: [{ state: "pending" }] },
        ],
      },
    };
    replayRegistry.register("listTransactions", async () => mixed);
    recordResult("listTransactions", { limit: 42 }, mixed);
    const node = tableView({
      columns: [
        { key: "merchant", label: "Merchant" },
        { key: "status", label: "Status" },
      ],
      rows: [{ merchant: "A", status: "posted" }],
      source: { tool: "listTransactions", input: { limit: 42 }, rowsPath: "/data/data" },
    });
    const payload = (node as { payload: GeneratedPayload }).payload;
    expect(payload.queries).toBeUndefined();
  });
});

describe("data-bound views carry the source tool's declared field formats", () => {
  // The live repro (voice-view-formats): a bound Spending Breakdown table
  // rendered raw integer cents because the model's formatting is DISCARDED
  // when rows bind to the verbatim cached result — the declared
  // x-vendo-formats map must travel into the Table columns instead.
  it("stamps format onto matching columns when the source binds", () => {
    const raw = { ok: true, data: { data: [{ category: "housing", amount: 285000 }] } };
    replayRegistry.register("getSpendingInsights", async () => raw);
    recordResult("getSpendingInsights", { month: "2026-07" }, raw);
    const node = tableView({
      title: "Spending Breakdown by Category",
      columns: [
        { key: "category", label: "Category" },
        { key: "amount", label: "Amount" },
      ],
      rows: raw.data.data,
      source: { tool: "getSpendingInsights", input: { month: "2026-07" }, rowsPath: "/data/data" },
    });
    const payload = (node as { payload: GeneratedPayload }).payload;
    expect(payload.queries?.[0]?.tool).toBe("getSpendingInsights");
    const table = payload.nodes.find((n) => n.component === "Table");
    expect(table?.props?.columns).toEqual([
      { key: "category", label: "Category" },
      { key: "amount", label: "Amount", format: "cents" },
    ]);
  });

  it("leaves snapshot (unbound) columns unstamped — the model formats those rows", () => {
    const node = tableView({
      columns: [{ key: "amount", label: "Amount" }],
      rows: [{ amount: "$2,850.00" }],
    });
    const payload = (node as { payload: GeneratedPayload }).payload;
    const table = payload.nodes.find((n) => n.component === "Table");
    expect(table?.props?.columns).toEqual([{ key: "amount", label: "Amount" }]);
  });
});

describe("voice host tools carry result-field format hints", () => {
  it("appends RESULT FIELD FORMATS to annotated tools' voice descriptions", () => {
    const { hostVoiceTools } = __voiceTesting;
    const byName = (name: string) => {
      const tool = hostVoiceTools.find((t) => t.name === name);
      if (!tool) throw new Error(`missing voice tool ${name}`);
      return tool;
    };
    // Money-bearing reads: the cents rule must reach the voice model too.
    for (const name of ["listTransactions", "listAccounts", "getBudgets"]) {
      const description = byName(name).description;
      expect(description, name).toContain("RESULT FIELD FORMATS");
      expect(description, name).toMatch(/divide by (exactly )?100/i);
    }
    expect(byName("listTransactions").description).toContain('"amount"');
    expect(byName("listAccounts").description).toContain('"balance"');
    // A tool without formats keeps its plain description.
    expect(byName("listPayees").description).not.toContain("RESULT FIELD FORMATS");
  });
});
