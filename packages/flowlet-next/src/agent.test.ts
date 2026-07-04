import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { defaultBrand } from "@flowlet/components/theme";
import { buildInstructions, createAgentCache } from "./agent";
import { defaultFlowletPolicy } from "./default-policy";

const BASE = {
  productName: "Acme",
  brand: defaultBrand,
  components: [],
  hostToolNames: [],
  integrations: [],
  automations: false,
};

describe("buildInstructions", () => {
  it("grounds the prompt in the product name, brand tokens and catalog", () => {
    const text = buildInstructions(BASE);
    expect(text).toContain("Acme's assistant");
    expect(text).toContain(defaultBrand.accent); // brand guidance carries tokens
    expect(text).toContain("render_view");
    expect(text).toContain("source:'prewired'");
  });

  it("only mentions connect/automations/host-API sections when enabled", () => {
    const off = buildInstructions(BASE);
    expect(off).not.toContain("request_connect({");
    expect(off).not.toContain("create_automation");
    expect(off).not.toContain("HOST API");

    const on = buildInstructions({
      ...BASE,
      hostToolNames: ["list_things", "create_thing"],
      integrations: [{ id: "gmail", name: "Gmail" }],
      automations: true,
    });
    expect(on).toContain("request_connect({");
    expect(on).toContain("gmail");
    expect(on).toContain("create_automation");
    expect(on).toContain("list_things, create_thing");
  });

  it("appends host extra instructions verbatim", () => {
    const text = buildInstructions({ ...BASE, extra: "ALWAYS SPEAK PIRATE." });
    expect(text.endsWith("ALWAYS SPEAK PIRATE.")).toBe(true);
  });
});

describe("createAgentCache", () => {
  const model = { modelId: "stub" } as unknown as LanguageModel;

  it("reuses the agent for a stable key and rebuilds when toolkits change", () => {
    let toolkits: string[] = [];
    const getAgent = createAgentCache({
      model,
      policy: defaultFlowletPolicy,
      instructions: "x",
      components: [],
      toolkits: () => toolkits,
    });
    const a = getAgent();
    expect(getAgent()).toBe(a);
    toolkits = ["gmail"];
    const b = getAgent();
    expect(b).not.toBe(a);
    // order-insensitive key
    toolkits = ["gmail"];
    expect(getAgent()).toBe(b);
  });

  it("rebuilds when the host cache key changes (e.g. a store generation)", () => {
    let gen = 0;
    const getAgent = createAgentCache({
      model,
      policy: defaultFlowletPolicy,
      instructions: "x",
      components: [],
      cacheKey: () => String(gen),
    });
    const a = getAgent();
    gen = 1;
    expect(getAgent()).not.toBe(a);
  });
});
