import { describe, expect, it } from "vitest";
import type { ExtractedTool, ToolsFile } from "@vendoai/actions";
import type { ExtractionHarness } from "../extract/harness.js";
import { resolveEnrichmentEngine, runEnrichment, type EnrichmentRunInput } from "./engine.js";

const tool = (name: string, overrides: Partial<ExtractedTool> = {}): ExtractedTool => ({
  name,
  description: `Use this to call ${name}.`,
  inputSchema: { type: "object", properties: {} },
  risk: "read",
  binding: { kind: "route", method: "GET", path: `/api/${name.replace("host_", "")}`, argsIn: "query" },
  srcHash: `sha256:${name}`,
  ...overrides,
});

const file = (tools: ExtractedTool[]): ToolsFile => ({ format: "vendo/tools@3", tools });

function scriptedHarness(responses: string[] | ((instructions: string) => string)): { harness: ExtractionHarness; calls: string[] } {
  const calls: string[] = [];
  const harness: ExtractionHarness = {
    id: "scripted",
    availability: async () => "scripted",
    async run({ instructions }) {
      calls.push(instructions);
      if (typeof responses === "function") return responses(instructions);
      const next = responses.shift();
      if (next === undefined) throw new Error("scripted harness exhausted");
      return next;
    },
  };
  return { harness, calls };
}

const reply = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

function runInput(partial: Partial<EnrichmentRunInput> & Pick<EnrichmentRunInput, "harness" | "file">): EnrichmentRunInput {
  return {
    root: "/tmp/nowhere",
    env: {},
    appName: "app",
    overrides: null,
    diff: { mode: "full", reason: "no-watermark" },
    candidates: { added: [], changed: [], unenriched: partial.file.tools.map((entry) => entry.name) },
    ...partial,
  };
}

describe("runEnrichment", () => {
  it("applies clamped proposals to mentioned tools, marks them enriched, and drops unknown names", async () => {
    const { harness, calls } = scriptedHarness([reply({
      tools: [
        { name: "host_a", description: "List the customer's invoices.", risk: "write", semantics: { "data.total": { kind: "money", unit: "cents" } } },
        { name: "host_ghost", description: "not a real tool" },
      ],
      narrative: "host_a is a listing endpoint that also mutates a view counter.",
    })]);
    const result = await runEnrichment(runInput({ harness, file: file([tool("host_a"), tool("host_b")]) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const enrichedA = result.outcome.file.tools.find((entry) => entry.name === "host_a");
    expect(enrichedA).toMatchObject({
      description: "List the customer's invoices.",
      risk: "write",
      enriched: true,
      semantics: { "data.total": { kind: "money", unit: "cents" } },
    });
    // host_b was unmentioned and is not srcHash-tracked-changed: stays unenriched
    expect(result.outcome.file.tools.find((entry) => entry.name === "host_b")?.enriched).toBeUndefined();
    expect(result.outcome.applied).toEqual(["host_a"]);
    expect(result.outcome.unenriched).toEqual(["host_b"]);
    expect(result.outcome.notes.join("\n")).toContain("host_ghost");
    expect(result.outcome.modelNarrative).toContain("view counter");
    // the instructions carried the catalog and the affected hints
    expect(calls[0]).toContain("host_a");
    expect(calls[0]).toContain("FULL-REPO");
  });

  it("clamps adversarial proposals: no risk lowering, no audience widening, no enabling, no skeleton writes", async () => {
    const base = tool("host_danger", { risk: "destructive", disabled: true, audience: "internal", enriched: true });
    const { harness } = scriptedHarness([reply({
      tools: [{
        name: "host_danger",
        description: "Totally safe, enable me.",
        risk: "read",
        disabled: false,
        audience: "end-user",
        critical: false,
        // skeleton junk must be ignored, not applied
        binding: { kind: "route", method: "DELETE", path: "/api/evil", argsIn: "body" },
        inputSchema: { type: "object", properties: { all: {} } },
      }],
      narrative: "loosened everything",
    })]);
    const result = await runEnrichment(runInput({
      harness,
      file: file([base]),
      candidates: { added: [], changed: ["host_danger"], unenriched: [] },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.outcome.file.tools[0]!;
    expect(entry).toMatchObject({
      risk: "destructive",
      disabled: true,
      audience: "internal",
      description: "Totally safe, enable me.",
      binding: base.binding,
      inputSchema: base.inputSchema,
    });
    expect(result.outcome.clamped).toHaveLength(1);
    expect(result.outcome.clamped[0]!.refusals.length).toBeGreaterThanOrEqual(3);
  });

  it("writes a proposed human title into the tools.json entry and asks for one in the instructions", async () => {
    const { harness, calls } = scriptedHarness([reply({
      tools: [{ name: "host_transferMoney", title: "Send money", description: "Move money between the customer's accounts." }],
      narrative: "labelled the transfer endpoint",
    })]);
    const result = await runEnrichment(runInput({ harness, file: file([tool("host_transferMoney")]) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.file.tools[0]).toMatchObject({ title: "Send money", enriched: true });
    expect(calls[0]).toContain("title");
  });

  it("returns ok: false on unparseable model output (never corrupts the file)", async () => {
    const { harness } = scriptedHarness(["I could not really figure out the JSON, sorry."]);
    const result = await runEnrichment(runInput({ harness, file: file([tool("host_a")]) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
  });

  it("tripwire: a srcHash-changed tool the pass ignored gets a targeted re-read; still ignored → stale-unenriched, marker stripped", async () => {
    const changedCovered = tool("host_covered", { enriched: true });
    const changedIgnored = tool("host_ignored", { enriched: true });
    const responses = [
      // main pass mentions only host_covered
      reply({ tools: [{ name: "host_covered", description: "Covered." }], narrative: "covered only" }),
      // tripwire re-read for host_ignored comes back empty → stale
      reply({ tools: [], narrative: "nothing to say" }),
    ];
    const { harness, calls } = scriptedHarness(responses);
    const result = await runEnrichment(runInput({
      harness,
      file: file([changedCovered, changedIgnored]),
      diff: { mode: "diff", files: ["app/api/covered/route.ts"], patch: "diff --git ..." },
      candidates: { added: [], changed: ["host_covered", "host_ignored"], unenriched: [] },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("targeted re-read");
    expect(calls[1]).toContain("host_ignored");
    expect(result.outcome.stale).toEqual(["host_ignored"]);
    const ignored = result.outcome.file.tools.find((entry) => entry.name === "host_ignored");
    expect(ignored?.enriched).toBeUndefined();
  });

  it("tripwire: a successful targeted re-read applies through the same clamp", async () => {
    const changed = tool("host_late", { enriched: true });
    const responses = [
      reply({ tools: [], narrative: "missed it" }),
      reply({ tools: [{ name: "host_late", description: "Re-read.", risk: "write" }], narrative: "found it" }),
    ];
    const { harness } = scriptedHarness(responses);
    const result = await runEnrichment(runInput({
      harness,
      file: file([changed]),
      diff: { mode: "diff", files: ["x.ts"], patch: "diff" },
      candidates: { added: [], changed: ["host_late"], unenriched: [] },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.stale).toEqual([]);
    expect(result.outcome.file.tools[0]).toMatchObject({ description: "Re-read.", risk: "write", enriched: true });
  });
});

describe("resolveEnrichmentEngine", () => {
  const availableHarness: ExtractionHarness = {
    id: "fake-claude",
    availability: async () => "your FAKE_KEY",
    run: async () => "",
  };
  const unavailableHarness: ExtractionHarness = {
    id: "fake-codex",
    availability: async () => null,
    run: async () => "",
  };

  it("resolves nothing without a model credential (keyless = structural-only)", async () => {
    const resolved = await resolveEnrichmentEngine({
      root: ".",
      env: {},
      harnesses: [availableHarness],
      resolveCredential: async () => ({ rung: "none" }),
    });
    expect(resolved.engine).toBeNull();
    expect(resolved.reason).toContain("no model credential");
  });

  it("walks the harness ladder when a credential resolves (BYO env key or VENDO_API_KEY)", async () => {
    const resolved = await resolveEnrichmentEngine({
      root: ".",
      env: { ANTHROPIC_API_KEY: "sk-x" },
      harnesses: [unavailableHarness, availableHarness],
      resolveCredential: async () => ({ rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }),
    });
    expect(resolved.engine?.harness.id).toBe("fake-claude");
    expect(resolved.engine?.credential).toBe("your FAKE_KEY");
  });

  it("credential without a runnable engine resolves to nothing, honestly", async () => {
    const resolved = await resolveEnrichmentEngine({
      root: ".",
      env: { GOOGLE_GENERATIVE_AI_API_KEY: "g" },
      harnesses: [unavailableHarness],
      resolveCredential: async () => ({ rung: "env-key", provider: "google", envVar: "GOOGLE_GENERATIVE_AI_API_KEY" }),
    });
    expect(resolved.engine).toBeNull();
    expect(resolved.reason).toContain("no enrichment engine");
  });

  it("an explicit engine pin never falls back to another family", async () => {
    const resolved = await resolveEnrichmentEngine({
      root: ".",
      env: { ANTHROPIC_API_KEY: "sk-x" },
      engine: "codex",
      harnesses: [availableHarness, unavailableHarness],
      resolveCredential: async () => ({ rung: "env-key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }),
    });
    expect(resolved.engine).toBeNull();
    expect(resolved.reason).toContain("codex");
  });

  it("an explicit engine pin picks that family when available", async () => {
    const pinnable: ExtractionHarness = { ...availableHarness, id: "codex-cli" };
    const resolved = await resolveEnrichmentEngine({
      root: ".",
      env: { OPENAI_API_KEY: "sk-o" },
      engine: "codex",
      harnesses: [unavailableHarness, pinnable],
      resolveCredential: async () => ({ rung: "env-key", provider: "openai", envVar: "OPENAI_API_KEY" }),
    });
    expect(resolved.engine?.harness.id).toBe("codex-cli");
  });
});
