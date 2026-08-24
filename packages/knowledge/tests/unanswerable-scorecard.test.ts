import type {
  KnowledgeAdapter,
  KnowledgeContext,
  KnowledgeQuery,
  RunContext,
  ToolRegistry,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { describe, expect, it } from "vitest";
import {
  createKnowledgeTools,
  VENDO_KNOWLEDGE_SEARCH_TOOL,
  type KnowledgeResultEnvelope,
  type KnowledgeResultOutcome,
} from "../src/index.js";
import * as knowledgeApi from "../src/index.js";
import { vendoKnowledge } from "../src/local/lexical.js";
import { CORPUS, ITEMS, type ScorecardItem } from "./fixtures/unanswerable-scorecard.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "scorecard" },
  venue: "chat",
  presence: "present",
  sessionId: "scorecard-session",
};

interface SearchRecord {
  intent: KnowledgeQuery["intent"];
}

interface ScorecardRow {
  id: string;
  kind: ScorecardItem["kind"];
  query: string;
  outcome: KnowledgeResultOutcome | "error";
  hitCount: number;
  topDocId: string | null;
  intents: Array<KnowledgeQuery["intent"]>;
}

function spyAdapter(adapter: KnowledgeAdapter): KnowledgeAdapter & { searches: SearchRecord[] } {
  const searches: SearchRecord[] = [];
  return {
    ...adapter,
    searches,
    async search(query: KnowledgeQuery, searchCtx: KnowledgeContext) {
      searches.push({ intent: query.intent ?? "chat" });
      return adapter.search(query, searchCtx);
    },
  };
}

async function seedTools(weakScoreThreshold?: number): Promise<{
  registry: ToolRegistry;
  adapter: KnowledgeAdapter & { searches: SearchRecord[] };
}> {
  const store = memoryStoreAdapter();
  const base = vendoKnowledge({ store });
  await base.upsert!(CORPUS);
  const adapter = spyAdapter(base);
  const registry = createKnowledgeTools(
    adapter,
    weakScoreThreshold === undefined ? {} : { weakScoreThreshold },
  );
  return { registry, adapter };
}

async function runItem(
  registry: ToolRegistry,
  adapter: { searches: SearchRecord[] },
  item: ScorecardItem,
): Promise<ScorecardRow> {
  const before = adapter.searches.length;
  const result = await registry.execute(
    { id: `call_${item.id}`, tool: VENDO_KNOWLEDGE_SEARCH_TOOL, args: { query: item.query } },
    ctx,
  );
  const intents = adapter.searches.slice(before).map((record) => record.intent);
  if (result.status !== "ok") {
    return {
      id: item.id,
      kind: item.kind,
      query: item.query,
      outcome: "error",
      hitCount: 0,
      topDocId: null,
      intents,
    };
  }
  const envelope = result.output as unknown as KnowledgeResultEnvelope;
  const hits = envelope.hits ?? [];
  return {
    id: item.id,
    kind: item.kind,
    query: item.query,
    outcome: envelope.outcome,
    hitCount: hits.length,
    topDocId: hits[0]?.docId ?? null,
    intents,
  };
}

function formatTable(rows: ScorecardRow[]): string {
  const header = ["id", "kind", "outcome", "hits", "topDocId", "intents", "query"].join("\t");
  const body = rows.map((row) =>
    [
      row.id,
      row.kind,
      row.outcome,
      String(row.hitCount),
      row.topDocId ?? "-",
      row.intents.join("→") || "-",
      row.query,
    ].join("\t"),
  );
  return [header, ...body].join("\n");
}

describe("unanswerable scorecard vs vendo_knowledge_search (no verifier)", () => {
  it("does not export or resurrect entailmentVerifier", () => {
    expect(knowledgeApi).not.toHaveProperty("entailmentVerifier");
    expect("entailmentVerifier" in knowledgeApi).toBe(false);
  });

  it("runs a 20-item single/multi/no-source eval through the shipped execute path", async () => {
    expect(ITEMS).toHaveLength(20);
    const { registry, adapter } = await seedTools();
    const rows: ScorecardRow[] = [];
    for (const item of ITEMS) {
      rows.push(await runItem(registry, adapter, item));
    }

    const table = formatTable(rows);
    // Printed so the captured vitest log is the raw outcomes table.
    console.log("\n=== vendo_knowledge_search scorecard (weakScoreThreshold default 0) ===\n");
    console.log(table);

    const ofKind = (kind: ScorecardItem["kind"]) => rows.filter((row) => row.kind === kind);
    const overlap = ofKind("no-source-overlap");
    const empty = ofKind("no-source-empty");
    const single = ofKind("single-source");
    const multi = ofKind("multi-source");
    const overlapAnswered = overlap.filter((row) => row.outcome === "answered");
    const emptyRefused = empty.filter((row) => row.outcome === "insufficient-evidence");

    console.log(
      [
        "",
        `single-source answered: ${single.filter((row) => row.outcome === "answered").length}/${single.length}`,
        `multi-source answered: ${multi.filter((row) => row.outcome === "answered").length}/${multi.length}`,
        `no-source-empty insufficient-evidence: ${emptyRefused.length}/${empty.length}`,
        `no-source-overlap answered (leak at threshold 0): ${overlapAnswered.length}/${overlap.length}`,
        "",
      ].join("\n"),
    );

    expect(rows.every((row) => row.outcome !== "error")).toBe(true);
    expect(single.length).toBe(8);
    expect(multi.length).toBe(4);
    expect(empty.length).toBe(3);
    expect(overlap.length).toBe(5);

    // Answerable items retrieve. Empty-hit refuse is NOT the leak.
    expect(single.every((row) => row.outcome === "answered" && row.hitCount > 0)).toBe(true);
    expect(multi.every((row) => row.outcome === "answered" && row.hitCount > 0)).toBe(true);
    expect(emptyRefused).toHaveLength(empty.length);
    expect(empty.every((row) => row.hitCount === 0)).toBe(true);
    expect(empty.every((row) => row.intents.join("→") === "chat→deep")).toBe(true);

    // The leftover 7–10/34 class: token overlap still returns `answered` at
    // default threshold 0, after chat search, with no deep retry and no verifier.
    expect(overlapAnswered.length).toBe(overlap.length);
    expect(overlap.every((row) => row.hitCount > 0)).toBe(true);
    expect(overlap.every((row) => row.intents.join("→") === "chat")).toBe(true);
  });

  it("calibration: a positive weakScoreThreshold on the same fixture (default stays 0)", async () => {
    const overlapCount = ITEMS.filter((item) => item.kind === "no-source-overlap").length;
    const singleCount = ITEMS.filter((item) => item.kind === "single-source").length;
    const leak = (rows: ScorecardRow[]) =>
      rows.filter((row) => row.kind === "no-source-overlap" && row.outcome === "answered").length;
    const singleAnswered = (rows: ScorecardRow[]) =>
      rows.filter((row) => row.kind === "single-source" && row.outcome === "answered").length;

    const lines = ["threshold\tleak_answered\tsingle_answered"];
    let defaultLeak = -1;
    for (const threshold of [0, 2, 8, 32]) {
      const seeded = await seedTools(threshold === 0 ? undefined : threshold);
      const rows: ScorecardRow[] = [];
      for (const item of ITEMS) {
        rows.push(await runItem(seeded.registry, seeded.adapter, item));
      }
      if (threshold === 0) defaultLeak = leak(rows);
      lines.push(`${threshold}\t${leak(rows)}/${overlapCount}\t${singleAnswered(rows)}/${singleCount}`);
    }

    console.log("\n=== weakScoreThreshold calibration on this fixture (default stays 0) ===");
    console.log(lines.join("\n"));

    // Default path still leaks. Raising the knob is recorded here; it is not
    // a production default change — overlap TF scores sit in the same band as
    // genuine answers, so the threshold cannot isolate the 7–10/34 class.
    expect(defaultLeak).toBe(overlapCount);
    const { registry } = await seedTools();
    const sample = ITEMS.find((item) => item.kind === "no-source-overlap")!;
    const stillDefault = await registry.execute(
      { id: "call_default_knob", tool: VENDO_KNOWLEDGE_SEARCH_TOOL, args: { query: sample.query } },
      ctx,
    );
    expect(stillDefault.status).toBe("ok");
    if (stillDefault.status === "ok") {
      expect((stillDefault.output as unknown as KnowledgeResultEnvelope).outcome).toBe("answered");
    }
  });
});
