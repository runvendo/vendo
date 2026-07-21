import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyDraft, composeInstructions, runAiExtraction } from "./extraction.js";
import { parseDraft, type ExtractionHarness, type ExtractionRunInput } from "./harness.js";
import type { Output } from "../shared.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const TOOLS = [
  { name: "host_invoices_list", description: "GET /api/invoices", risk: "read" as const, method: "GET", path: "/api/invoices" },
  { name: "host_invoices_create", description: "POST /api/invoices", risk: "write" as const, method: "POST", path: "/api/invoices" },
  { name: "host_admin_unclassified", description: "Route /api/admin could not be classified", risk: "destructive" as const, disabled: true },
];

async function fixture(overrides?: object, brief?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-extract-"));
  cleanup.push(root);
  await mkdir(join(root, ".vendo"), { recursive: true });
  await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({ format: "vendo/tools@1", tools: TOOLS }));
  await writeFile(join(root, ".vendo", "overrides.json"), JSON.stringify(
    overrides ?? { format: "vendo/overrides@1", tools: {}, remix: { ignoreSlots: [] } },
  ));
  await writeFile(join(root, ".vendo", "brief.md"),
    `${brief ?? "Describe this product, its users, and the jobs the agent should help them complete."}\n`);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "maple" }));
  return root;
}

function output(): { output: Output; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { output: { log: (message) => logs.push(message), error: (message) => errors.push(message) }, logs, errors };
}

async function readOverrides(root: string): Promise<{ tools: Record<string, Record<string, unknown>> }> {
  return JSON.parse(await readFile(join(root, ".vendo", "overrides.json"), "utf8"));
}

describe("parseDraft", () => {
  it("parses a fenced json block and bare json", () => {
    const draft = { brief: "A bank.", tools: [{ name: "t", description: "d" }] };
    expect(parseDraft("Here you go:\n```json\n" + JSON.stringify(draft) + "\n```")).toEqual(draft);
    expect(parseDraft(JSON.stringify(draft))).toEqual(draft);
  });

  it("throws on unparseable or schema-invalid output", () => {
    expect(() => parseDraft("no json here")).toThrow();
    expect(() => parseDraft('{"brief":""}')).toThrow();
  });

  it("survives stray braces in surrounding prose (Greptile P2)", () => {
    const draft = { brief: "A bank.", tools: [{ name: "t", description: 'has "quotes" and {braces}' }] };
    const noisy = `Checked {src/api} — handler is write-only.\n${JSON.stringify(draft)}\nNote: {unbalanced`;
    expect(parseDraft(noisy)).toEqual(draft);
  });
});

describe("composeInstructions", () => {
  it("carries the static facts and the guard rules", () => {
    const instructions = composeInstructions(TOOLS, "maple");
    expect(instructions).toContain("host_invoices_list");
    expect(instructions).toContain('"disabled": true');
    expect(instructions).toContain("never lower");
    expect(instructions).toContain("maple");
  });
});

describe("applyDraft (deterministic verification)", () => {
  it("applies descriptions, risk raises, critical marks, and wakes reasoned tools", async () => {
    const root = await fixture();
    const summary = await applyDraft({
      root,
      tools: TOOLS,
      draft: {
        brief: "Maple is a consumer bank; users check balances and pay bills.",
        tools: [
          { name: "host_invoices_list", description: "List invoices, filterable by status." },
          { name: "host_invoices_create", description: "Create and send an invoice.", risk: "destructive", critical: true },
          { name: "host_admin_unclassified", description: "Reset all demo data.", disabled: false, risk: "destructive", reasoning: "handler truncates tables" },
        ],
      },
    });
    expect(summary).toMatchObject({ described: 3, riskRaised: 1, critical: 1, woken: 1, briefWritten: true, refused: [] });
    const overrides = await readOverrides(root);
    expect(overrides.tools["host_invoices_list"]).toEqual({ description: "List invoices, filterable by status." });
    expect(overrides.tools["host_invoices_create"]).toMatchObject({ risk: "destructive", critical: true });
    expect(overrides.tools["host_admin_unclassified"]).toMatchObject({ disabled: false, risk: "destructive" });
    expect(await readFile(join(root, ".vendo", "brief.md"), "utf8")).toContain("consumer bank");
  });

  it("refuses unknown tools, risk downgrades, and unreasoned wakes", async () => {
    const root = await fixture();
    const summary = await applyDraft({
      root,
      tools: TOOLS,
      draft: {
        brief: "b",
        tools: [
          { name: "invented_tool", description: "nope" },
          { name: "host_invoices_create", description: "Create an invoice.", risk: "read" },
          { name: "host_admin_unclassified", description: "Wake me.", disabled: false },
        ],
      },
    });
    expect(summary.refused).toHaveLength(3);
    const overrides = await readOverrides(root);
    expect(overrides.tools["invented_tool"]).toBeUndefined();
    expect(overrides.tools["host_invoices_create"]?.risk).toBeUndefined();
    expect(overrides.tools["host_admin_unclassified"]?.disabled).toBeUndefined();
  });

  it("a reasoned wake carries the model's grade without a false downgrade refusal (Greptile P1)", async () => {
    const root = await fixture();
    const summary = await applyDraft({
      root,
      tools: TOOLS,
      draft: {
        brief: "b",
        tools: [{
          name: "host_admin_unclassified", description: "Lists admin settings.",
          disabled: false, risk: "read", reasoning: "handler only reads config rows",
        }],
      },
    });
    // The static "destructive" was a fail-closed placeholder, not evidence:
    // the wake applies the model's grade with NO contradictory refusal line.
    expect(summary).toMatchObject({ woken: 1, refused: [] });
    const overrides = await readOverrides(root);
    expect(overrides.tools["host_admin_unclassified"]).toMatchObject({ disabled: false, risk: "read" });
  });

  it("a wake never replaces a human-set risk or reverses a human disable decision", async () => {
    const root = await fixture({
      format: "vendo/overrides@1",
      tools: {
        host_admin_unclassified: { risk: "destructive" },
      },
    });
    const woken = await applyDraft({
      root,
      tools: TOOLS,
      draft: {
        brief: "b",
        tools: [{ name: "host_admin_unclassified", description: "d", disabled: false, risk: "read", reasoning: "r" }],
      },
    });
    expect(woken.woken).toBe(1);
    expect((await readOverrides(root)).tools["host_admin_unclassified"]).toMatchObject({ disabled: false, risk: "destructive" });

    const humanDisabled = await fixture({
      format: "vendo/overrides@1",
      tools: { host_admin_unclassified: { disabled: true } },
    });
    const kept = await applyDraft({
      root: humanDisabled,
      tools: TOOLS,
      draft: {
        brief: "b",
        tools: [{ name: "host_admin_unclassified", description: "d", disabled: false, risk: "read", reasoning: "r" }],
      },
    });
    expect(kept.woken).toBe(0);
    expect((await readOverrides(humanDisabled)).tools["host_admin_unclassified"]?.disabled).toBe(true);
  });

  it("never overwrites human decisions: existing override fields and a hand-written brief win", async () => {
    const root = await fixture(
      { format: "vendo/overrides@1", tools: { host_invoices_create: { description: "Human wrote this.", critical: false } } },
      "The humans already described this product.",
    );
    const summary = await applyDraft({
      root,
      tools: TOOLS,
      draft: {
        brief: "AI brief.",
        tools: [{ name: "host_invoices_create", description: "AI description.", critical: true }],
      },
    });
    expect(summary.briefWritten).toBe(false);
    const overrides = await readOverrides(root);
    expect(overrides.tools["host_invoices_create"]).toMatchObject({ description: "Human wrote this.", critical: false });
    expect(await readFile(join(root, ".vendo", "brief.md"), "utf8")).toContain("humans already");
  });
});

function fakeHarness(text: string | Error, credential: string | null = "your Claude Code login"): ExtractionHarness {
  return {
    id: "fake",
    availability: async () => credential,
    run: async () => {
      if (text instanceof Error) throw text;
      return text;
    },
  };
}

/** Identify which stage an instruction string belongs to (mirrors stages.test.ts). */
function stageOf(instructions: string): "survey" | "draft" | "cross-check" | "brief" | "theme" {
  if (instructions.includes("extraction surveyor")) return "survey";
  if (instructions.includes("cross-checker")) return "cross-check";
  if (instructions.includes("drafting the product brief")) return "brief";
  if (instructions.includes("filling the theme's brand slots")) return "theme";
  return "draft";
}

/** A scripted harness: responds per stage — for tests that need the theme
    stage to answer independently of the tool-polish stages. */
function scriptedHarness(
  respond: (stage: string, input: ExtractionRunInput) => object | Error,
  credential = "your Claude Code login",
): ExtractionHarness {
  return {
    id: "scripted",
    availability: async () => credential,
    run: async (input) => {
      const response = respond(stageOf(input.instructions), input);
      if (response instanceof Error) throw response;
      return "```json\n" + JSON.stringify(response) + "\n```";
    },
  };
}

describe("runAiExtraction", () => {
  it("skips silently-with-one-line when non-interactive", async () => {
    const root = await fixture();
    const sink = output();
    const result = await runAiExtraction({ root, output: sink.output, env: {}, yes: true, interactive: true });
    expect(result.ran).toBe(false);
    expect(sink.logs.join("\n")).toContain("skipped");
  });

  it("states when no credential exists and names every rung's remedy", async () => {
    const root = await fixture();
    const sink = output();
    const result = await runAiExtraction({
      root, output: sink.output, env: {}, yes: false, interactive: true,
      harnesses: [fakeHarness("x", null), fakeHarness("x", null), fakeHarness("x", null)],
    });
    expect(result.ran).toBe(false);
    const message = sink.logs.join("\n");
    expect(message).toContain("AI polish: unavailable");
    // Every rung's remedy is named — visible-never-silent (Task 2).
    expect(message).toContain("Claude Code installed");
    expect(message).toContain("ANTHROPIC_API_KEY");
    expect(message).toContain("codex");
    expect(message).toContain("codex login");
    expect(message).toContain("OPENAI_API_KEY");
  });

  it("picks the first rung when every rung is available (order matters)", async () => {
    const root = await fixture();
    const sink = output();
    const draft = { brief: "b", tools: [] };
    const scripted = "```json\n" + JSON.stringify(draft) + "\n```";
    const result = await runAiExtraction({
      root, output: sink.output, env: {}, yes: false, interactive: true,
      harnesses: [
        fakeHarness(scripted, "Agent SDK credential"),
        fakeHarness(scripted, "claude CLI credential"),
        fakeHarness(scripted, "codex CLI credential"),
      ],
      confirm: async () => true,
    });
    expect(result.ran).toBe(true);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Reading your product (Agent SDK credential)");
    expect(logs).not.toContain("claude CLI credential");
    expect(logs).not.toContain("codex CLI credential");
  });

  it("falls through to the claude CLI rung when the Agent SDK rung is unavailable", async () => {
    const root = await fixture();
    const sink = output();
    const draft = { brief: "b", tools: [] };
    const scripted = "```json\n" + JSON.stringify(draft) + "\n```";
    const result = await runAiExtraction({
      root, output: sink.output, env: {}, yes: false, interactive: true,
      harnesses: [
        fakeHarness("x", null),
        fakeHarness(scripted, "claude CLI credential"),
        fakeHarness(scripted, "codex CLI credential"),
      ],
      confirm: async () => true,
    });
    expect(result.ran).toBe(true);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Reading your product (claude CLI credential)");
    expect(logs).not.toContain("codex CLI credential");
  });

  it("falls through past two unavailable rungs to the codex CLI rung", async () => {
    const root = await fixture();
    const sink = output();
    const draft = { brief: "b", tools: [] };
    const scripted = "```json\n" + JSON.stringify(draft) + "\n```";
    const result = await runAiExtraction({
      root, output: sink.output, env: {}, yes: false, interactive: true,
      harnesses: [
        fakeHarness("x", null),
        fakeHarness("x", null),
        fakeHarness(scripted, "codex CLI credential"),
      ],
      confirm: async () => true,
    });
    expect(result.ran).toBe(true);
    expect(sink.logs.join("\n")).toContain("Reading your product (codex CLI credential)");
  });

  it("respects a declined consent", async () => {
    const root = await fixture();
    const sink = output();
    const result = await runAiExtraction({
      root, output: sink.output, env: {}, yes: false, interactive: true,
      harnesses: [fakeHarness("x")],
      confirm: async () => false,
    });
    expect(result.ran).toBe(false);
    expect(sink.logs.join("\n")).toContain("Skipped");
  });

  // Agent-install-dx: --ai-polish carries consent as a flag, so a
  // non-interactive run neither skips nor prompts — the flag IS the answer.
  it("a consent flag replaces the prompt and unlocks non-interactive runs", async () => {
    const root = await fixture();
    const sink = output();
    const draft = { brief: "b", tools: [] };
    const result = await runAiExtraction({
      root, output: sink.output, env: {}, yes: true, interactive: false, consent: true,
      harnesses: [fakeHarness("```json\n" + JSON.stringify(draft) + "\n```")],
      confirm: async () => { throw new Error("prompted"); },
    });
    expect(result.ran).toBe(true);
    expect(sink.logs.join("\n")).toContain("Reading your product");
  });

  it("runs the harness, applies the draft, and summarizes", async () => {
    const root = await fixture();
    const sink = output();
    const draft = {
      brief: "Maple is a consumer bank.",
      tools: [{ name: "host_invoices_list", description: "List invoices with status filters." }],
      missedSurfaces: ["/api/reports (GET) — monthly aging report"],
    };
    const result = await runAiExtraction({
      root, output: sink.output, env: {}, yes: false, interactive: true,
      harnesses: [fakeHarness("```json\n" + JSON.stringify(draft) + "\n```")],
      confirm: async () => true,
    });
    expect(result.ran).toBe(true);
    const logs = sink.logs.join("\n");
    expect(logs).toContain("Reading your product (your Claude Code login)");
    expect(logs).toContain("1 descriptions");
    expect(logs).toContain("brief drafted");
    expect(logs).toContain("missed surface");
    expect((await readOverrides(root)).tools["host_invoices_list"]?.description).toBe("List invoices with status filters.");
  });

  it("a failing harness degrades honestly and writes nothing", async () => {
    const root = await fixture();
    const before = await readFile(join(root, ".vendo", "overrides.json"), "utf8");
    const sink = output();
    const result = await runAiExtraction({
      root, output: sink.output, env: {}, yes: false, interactive: true,
      harnesses: [fakeHarness(new Error("model unreachable"))],
      confirm: async () => true,
    });
    expect(result.ran).toBe(false);
    expect(sink.errors.join("\n")).toContain("model unreachable");
    expect(await readFile(join(root, ".vendo", "overrides.json"), "utf8")).toBe(before);
  });

  it("the consent prompt mentions theme alongside tools, risk, and the brief", async () => {
    const root = await fixture();
    const sink = output();
    let question = "";
    await runAiExtraction({
      root, output: sink.output, env: {}, yes: false, interactive: true,
      harnesses: [fakeHarness("```json\n" + JSON.stringify({ brief: "b", tools: [] }) + "\n```")],
      confirm: async (asked) => { question = asked; return true; },
    });
    expect(question).toContain("theme");
  });

  it("threads a theme input into the staged call and surfaces the parsed draft on the result", async () => {
    const root = await fixture();
    const themeDraft = { slots: { accent: "#112233" }, uncertain: [{ slot: "accent", note: "two plausible brand colors" }] };
    const harness = scriptedHarness((stage) => {
      if (stage === "survey") return { surfaces: [{ name: "all", tools: TOOLS.map((tool) => tool.name) }] };
      if (stage === "draft") return { tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description ?? "" })) };
      if (stage === "cross-check") return { tools: [] };
      if (stage === "brief") return { brief: "b" };
      return themeDraft;
    });
    const sink = output();
    const result = await runAiExtraction({
      root, output: sink.output, env: {}, yes: false, interactive: true,
      harnesses: [harness],
      confirm: async () => true,
      theme: { needed: ["accent"], alreadyExact: {}, evidencePaths: ["app/globals.css"] },
    });
    expect(result.ran).toBe(true);
    expect(result.theme).toEqual(themeDraft);
  });

  it("runs the theme stage even when tools.json is missing or unparseable, without writing tool overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-extract-notheme-tools-"));
    cleanup.push(root);
    await mkdir(join(root, ".vendo"), { recursive: true });
    // No tools.json at all — tool polish has nothing to work from.
    const themeDraft = { slots: { accent: "#445566" } };
    const harness = scriptedHarness((stage) => {
      if (stage === "survey") return { surfaces: [{ name: "app", tools: [] }] };
      if (stage === "brief") return { brief: "b" };
      if (stage === "theme") return themeDraft;
      return { tools: [] };
    });
    const sink = output();
    const result = await runAiExtraction({
      root, output: sink.output, env: {}, yes: false, interactive: true,
      harnesses: [harness],
      confirm: async () => true,
      theme: { needed: ["accent"], alreadyExact: {}, evidencePaths: [] },
    });
    expect(result.ran).toBe(true);
    expect(result.theme).toEqual(themeDraft);
    await expect(readFile(join(root, ".vendo", "overrides.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still skips entirely when tools.json is missing and no theme input is given", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-extract-nothing-"));
    cleanup.push(root);
    await mkdir(join(root, ".vendo"), { recursive: true });
    const sink = output();
    const result = await runAiExtraction({
      root, output: sink.output, env: {}, yes: false, interactive: true,
      harnesses: [fakeHarness("```json\n" + JSON.stringify({ brief: "b", tools: [] }) + "\n```")],
      confirm: async () => { throw new Error("should never be asked"); },
    });
    expect(result.ran).toBe(false);
  });
});
