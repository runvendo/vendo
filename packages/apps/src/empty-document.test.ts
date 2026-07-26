import type { RunContext, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import {
  guardFixture,
  memoryStore,
  scriptedLanguageModel,
  type ScriptedModelCall,
} from "./testing/index.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_empty" },
  venue: "chat",
  presence: "present",
  sessionId: "session_empty",
};

const tools: ToolRegistry = {
  async descriptors() {
    return [{
      name: "host_rows",
      description: "List rows",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
    }];
  },
  async execute(call) {
    if (call.tool === "host_rows") {
      return { status: "ok", output: { data: [{ name: "Alpha", amountCents: 1200 }] } };
    }
    return { status: "error", error: { code: "not-found", message: "missing" } };
  },
};

const promptText = (call: ScriptedModelCall): string => call.prompt.map((message) => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text ?? "").join("");
}).join("\n");

const titleOnly =
  '<App name="Streaming subscriptions"><Stack gap={12}><Text text="Streaming subscriptions" variant="heading"/><Text text="Jan - Jul 2026" variant="caption"/></Stack></App>';

const titleWithDisclaimer =
  '<App name="Brokerage holdings"><Stack gap={12}><Text text="Brokerage holdings" variant="heading"/><Disclaimer reason="No tool on this host exposes brokerage holdings, so this can\'t be shown."/></Stack></App>';

const titleWithTable =
  '<App name="Subscriptions"><Query id="rows" tool="host_rows"/><Stack gap={12}><Text text="Subscriptions" variant="heading"/><DataTable rows={rows.data}/></Stack></App>';

/**
 * Re-gate 2026-07-26 finding 3 (evidence PR #588): arms A/B shipped 12
 * title-only apps — a bare heading (sometimes plus a caption), NO body, and
 * the emptiness reproduces on re-open. A document whose rooted tree renders
 * nothing data-bearing or interactive beyond headings/copy is a validation
 * issue routed to repair; an honest Disclaimer IS content (the legal move
 * when no tool backs the ask), and so is anything bound to data.
 */
describe("empty-document validity gate", () => {
  it("routes a title-only document to repair and ships the repaired app", async () => {
    const prompts: string[] = [];
    const model = scriptedLanguageModel((call, index) => {
      prompts.push(promptText(call));
      return index === 0 ? titleOnly : titleWithDisclaimer;
    });
    const runtime = createApps({ store: memoryStore(), guard: guardFixture(), tools, catalog: [], model });

    const app = await runtime.create({ prompt: "What am I paying for streaming?" }, ctx);

    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts[1]).toContain("title and no content");
    const components = (app.tree as { nodes: Array<{ component: string }> }).nodes.map(({ component }) => component);
    expect(components).toContain("Disclaimer");
  });

  it("accepts an honest title + Disclaimer document without repair", async () => {
    let calls = 0;
    const model = scriptedLanguageModel(() => {
      calls += 1;
      return titleWithDisclaimer;
    });
    const runtime = createApps({ store: memoryStore(), guard: guardFixture(), tools, catalog: [], model });

    const app = await runtime.create({ prompt: "Show my brokerage holdings" }, ctx);

    expect(calls).toBe(1);
    expect(app.name).toBe("Brokerage holdings");
  });

  it("accepts a title + DataTable document without repair", async () => {
    let calls = 0;
    const model = scriptedLanguageModel(() => {
      calls += 1;
      return titleWithTable;
    });
    const runtime = createApps({ store: memoryStore(), guard: guardFixture(), tools, catalog: [], model });

    const app = await runtime.create({ prompt: "List my subscriptions" }, ctx);

    expect(calls).toBe(1);
    const components = (app.tree as { nodes: Array<{ component: string }> }).nodes.map(({ component }) => component);
    expect(components).toContain("DataTable");
  });

  it("counts a data-bound Text as content (a bound value is not a bare heading)", async () => {
    let calls = 0;
    const boundText =
      '<App name="Total balance"><Query id="rows" tool="host_rows"/><Stack gap={12}><Text text="Total balance" variant="heading"/><Text text={rows.data.0.name}/></Stack></App>';
    const model = scriptedLanguageModel(() => {
      calls += 1;
      return boundText;
    });
    const runtime = createApps({ store: memoryStore(), guard: guardFixture(), tools, catalog: [], model });

    await runtime.create({ prompt: "What is my total balance?" }, ctx);

    expect(calls).toBe(1);
  });
});
