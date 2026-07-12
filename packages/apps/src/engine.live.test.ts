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

type ModelFactory = (options: { apiKey: string }) => LanguageModel | Promise<LanguageModel>;

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("generation engine live LLM", () => {
  it.skipIf(!process.env.VENDO_LIVE_MODEL_MODULE)(
    "builds a small catalog-aware dashboard with a host-provided model factory",
    async () => {
      const moduleName = process.env.VENDO_LIVE_MODEL_MODULE;
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (moduleName === undefined || apiKey === undefined) throw new Error("live model environment is incomplete");
      const loaded = await import(moduleName) as { default?: ModelFactory; createModel?: ModelFactory };
      const factory = loaded.createModel ?? loaded.default;
      if (factory === undefined) {
        throw new Error("VENDO_LIVE_MODEL_MODULE must export createModel or a default model factory");
      }
      const runtime = createApps({
        store: memoryStore(),
        guard: guardFixture(),
        tools,
        catalog,
        model: await factory({ apiKey }),
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
