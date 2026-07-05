import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { defaultBrand } from "@vendoai/components/theme";
import { buildInstructions, createAgentCache } from "./agent.js";
import { defaultVendoPolicy } from "./default-policy.js";

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

  it("grounds host identity: the configured product name is the only permitted name", () => {
    const text = buildInstructions(BASE);
    expect(text).toContain("HOST IDENTITY");
    expect(text).toContain('"Acme"');
    expect(text).toMatch(/never invent/i);
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

  it("carries host extra instructions verbatim, with only the platform guardrails after", () => {
    const text = buildInstructions({ ...BASE, extra: "ALWAYS SPEAK PIRATE." });
    expect(text).toContain("ALWAYS SPEAK PIRATE.");
    // Guarded order (spec §1): host extras never get recency over guardrails.
    expect(text.indexOf("NON-NEGOTIABLES")).toBeGreaterThan(text.indexOf("ALWAYS SPEAK PIRATE."));
    expect(text.trimEnd().endsWith("these rules win.")).toBe(true);
  });
});

describe("createAgentCache", () => {
  const model = { modelId: "stub" } as unknown as LanguageModel;

  it("reuses the agent for a stable key and rebuilds when toolkits change", async () => {
    let toolkits: string[] = [];
    const getAgent = createAgentCache({
      model,
      policy: defaultVendoPolicy,
      instructions: "x",
      components: [],
      toolkits: () => toolkits,
    });
    const a = await getAgent();
    expect(await getAgent()).toBe(a);
    toolkits = ["gmail"];
    const b = await getAgent();
    expect(b).not.toBe(a);
    // order-insensitive key
    toolkits = ["gmail"];
    expect(await getAgent()).toBe(b);
  });

  it("also accepts an async toolkits callback (the durable connections store shape)", async () => {
    let toolkits: string[] = [];
    const getAgent = createAgentCache({
      model,
      policy: defaultVendoPolicy,
      instructions: "x",
      components: [],
      toolkits: async () => toolkits,
    });
    const a = await getAgent();
    expect(await getAgent()).toBe(a);
    toolkits = ["slack"];
    expect(await getAgent()).not.toBe(a);
  });

  it("rebuilds when the host cache key changes (e.g. a store generation)", async () => {
    let gen = 0;
    const getAgent = createAgentCache({
      model,
      policy: defaultVendoPolicy,
      instructions: "x",
      components: [],
      cacheKey: () => String(gen),
    });
    const a = await getAgent();
    gen = 1;
    expect(await getAgent()).not.toBe(a);
  });
});

// Migration diff test (shared-prompt-core spec, docs/superpowers/specs/
// 2026-07-04-context-engineering-design.md): anchored on the FROZEN
// pre-migration fixture, so it can never compare the new path to itself.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prewiredComponents } from "@vendoai/components/descriptors";

describe("default prompt migration diff", () => {
  const fixturePath = join(__dirname, "__fixtures__", "default-instructions.baseline.txt");

  // Legacy phrasings the shared prompt core intentionally superseded — the
  // ONLY fixture lines allowed to disappear. Everything else must survive
  // verbatim. Reviewed hunks; see the spec's §1 "Consumers migrated".
  const INTENDED_REMOVALS = [
    // show-vs-say converged to the richer shared wording (adds the example)
    /answer is genuinely better as a chart\/table\/clock than a sentence\.$/,
    // refreshable-views converged to the shared wording (concrete example)
    /re-runnable: put the tool's result VERBATIM at one path in `data`, bind props/,
    /into that subtree with \{ \$path \} or transform it inside a generated component,/,
    /and declare queries: \[\{ path: '\/x', tool: '<tool>', input: \{\.\.\.\} \}\]\. Saved views/,
    /^re-run those queries on reopen to show fresh data\. Do NOT reshape tool output$/,
    /^before storing it at the declared path — reshape at render time\.$/,
    // novel-components converged (gains React.createElement + REPLACES lines)
    /keyboard\/mouse handlers, and useState — so games and interactive widgets live here\.$/,
    // connect section converged to the shared wording (re-wrapped lines)
    /^CONNECTING TOOLS — external tools \(Gmail, Slack, etc\.\) are only available once$/,
    /^the user has CONNECTED them\. If a request needs a tool that is not yet connected$/,
    /^\(you'll notice the tool simply isn't in your toolset\), do NOT refuse and do NOT$/,
    /^try to render Connect via render_view\. Instead call the request_connect tool:$/,
    /^request_connect\(\{ toolkit: "<id>", reason: "<short why>" \}\)\. Use the toolkit id$/,
    /^\(gmail, slack\)\. You may briefly say you're$/,
    /^requesting access\. Once the user connects it, they can re-ask and you'll have the tool\.$/,
  ];

  it("keeps every non-superseded fixture line and adds only the approved sections", () => {
    const current = buildInstructions({
      productName: "Acme",
      brand: defaultBrand,
      // One stable catalog entry exercises the host-components section.
      components: [prewiredComponents[0]],
      hostToolNames: ["list_things", "create_thing"],
      integrations: [
        { id: "gmail", name: "Gmail" },
        { id: "slack", name: "Slack" },
      ],
      automations: true,
      extra: "HOST EXTRA SECTION — verbatim.",
    });
    const baseline = readFileSync(fixturePath, "utf8");
    const currentLines = new Set(current.split("\n"));

    const lost = baseline
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => !currentLines.has(line))
      .filter((line) => !INTENDED_REMOVALS.some((re) => re.test(line)));
    expect(lost, `fixture lines lost without an approved removal:\n${lost.join("\n")}`).toEqual([]);

    // The approved additions (spec sections) are present, in guarded order.
    for (const anchor of [
      "TALKING ABOUT WHAT YOU CAN DO",
      "APPROVALS:",
      "REGISTER — how you talk",
      "SUGGESTIONS:",
      "NON-NEGOTIABLES",
    ]) {
      expect(current).toContain(anchor);
    }
    expect(current.indexOf("NON-NEGOTIABLES")).toBeGreaterThan(
      current.indexOf("HOST EXTRA SECTION — verbatim."),
    );
  });
});
