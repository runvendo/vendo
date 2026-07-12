import {
  validateTree,
  type ComponentCatalog,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import { guardFixture, memoryStore } from "./testing/index.js";

const catalog: ComponentCatalog = [
  {
    name: "MetricCard",
    description: "A branded card showing a metric label, value, and optional trend.",
    propsSchema: { "~standard": { validate: (value: unknown) => value } },
  },
  {
    name: "TrendChart",
    description: "A branded time-series chart for an array of labeled values.",
    propsSchema: { "~standard": { validate: (value: unknown) => value } },
  },
  {
    name: "DashboardHeader",
    description: "A branded dashboard title and short explanatory subtitle.",
    propsSchema: { "~standard": { validate: (value: unknown) => value } },
  },
];

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_live_engine" },
  venue: "chat",
  presence: "present",
  sessionId: "session_live_engine",
};

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("generation engine live LLM", () => {
  it(
    "builds a small catalog-aware dashboard with a live Anthropic model",
    { timeout: 120_000 },
    async () => {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const runtime = createApps({
        store: memoryStore(),
        guard: guardFixture(),
        tools,
        catalog,
        model: anthropic("claude-sonnet-5") as LanguageModel,
      });

      const app = await runtime.create({
        prompt: "Build a compact sales dashboard with a title, three headline metrics, and a weekly trend.",
      }, ctx);

      expect(validateTree({ ...app.tree, components: app.components }).ok).toBe(true);
      const nodes = (app.tree as { nodes?: Array<{ component?: string; source?: string }> }).nodes ?? [];
      expect(nodes.some((node) => node.source === "host" && catalog.some(({ name }) => name === node.component))).toBe(true);
    },
  );
});
