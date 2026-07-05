import { describe, expect, it } from "vitest";
import { voiceSessionBrief } from "./session-brief";
import type { ThreadItem } from "../use-vendo-thread";
import type { Vendo } from "../seams/store";
import type { UINode } from "@vendoai/core";

const tableNode: UINode = {
  id: "v1",
  kind: "generated",
  payload: {
    formatVersion: "vendo-genui/v1",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["t", "table"] },
      { id: "t", component: "Text", props: { text: "March Transactions" } },
      {
        id: "table",
        component: "Table",
        source: "prewired",
        props: { columns: [{ key: "m", label: "M" }], rows: [{ m: 1 }, { m: 2 }, { m: 3 }] },
      },
    ],
    queries: [{ path: "/source", tool: "listTransactions", input: { month: "march" } }],
  },
} as unknown as UINode;

const items: ThreadItem[] = [
  { kind: "text", key: "k1", messageId: "m1", role: "user", text: "show me March" },
  {
    kind: "tool",
    key: "k2",
    messageId: "m2",
    toolName: "listTransactions",
    state: "output-available",
    input: { month: "march" },
    output: { ok: true, data: { transactions: [{ id: 1 }, { id: 2 }] } },
  },
  { kind: "ui", key: "k3", messageId: "m3", node: tableNode },
  { kind: "text", key: "k4", messageId: "m4", role: "assistant", text: "Here's March." },
];

const flows: Vendo[] = [
  { id: "f1", name: "Coffee Spend", node: tableNode, createdAt: 0, updatedAt: 0 } as unknown as Vendo,
];

describe("voiceSessionBrief (spec §4)", () => {
  it("renders all four blocks: tail, on-screen views, tool digests, saved vendos", () => {
    const brief = voiceSessionBrief({ items, flows });
    expect(brief).toContain("user: show me March");
    expect(brief).toContain("assistant: Here's March.");
    // view awareness with title, row count, provenance
    expect(brief).toMatch(/a table, titled "March Transactions", 3 rows, from listTransactions/);
    // tool digest is shape, not payload
    expect(brief).toContain("listTransactions");
    expect(brief).toMatch(/transactions: array of 2/);
    expect(brief).not.toContain('"id": 1');
    // saved vendos by name AND id for open_saved_vendo
    expect(brief).toContain('"Coffee Spend" (id f1)');
    expect(brief).toContain("open_saved_vendo");
  });

  it("returns empty for an empty thread with no flows", () => {
    expect(voiceSessionBrief({ items: [] })).toBe("");
  });

  it("stays within the total budget on a huge thread", () => {
    const big: ThreadItem[] = Array.from({ length: 200 }, (_, i) => ({
      kind: "text" as const,
      key: `k${i}`,
      messageId: `m${i}`,
      role: "user" as const,
      text: `message ${i} ${"x".repeat(200)}`,
    }));
    const brief = voiceSessionBrief({ items: big, flows });
    expect(brief.length).toBeLessThanOrEqual(3_600);
  });
});
