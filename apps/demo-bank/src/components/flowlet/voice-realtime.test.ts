import { describe, expect, it } from "vitest";
import { replayRegistry } from "@flowlet/shell";
import type { GeneratedPayload } from "@flowlet/core";
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
