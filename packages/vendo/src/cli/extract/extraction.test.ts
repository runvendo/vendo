import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyDraft, composeInstructions, runAiExtraction } from "./extraction.js";
import { parseDraft, type ExtractionHarness } from "./harness.js";
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

describe("runAiExtraction", () => {
  it("skips silently-with-one-line when non-interactive", async () => {
    const root = await fixture();
    const sink = output();
    const result = await runAiExtraction({ root, output: sink.output, env: {}, yes: true, interactive: true });
    expect(result.ran).toBe(false);
    expect(sink.logs.join("\n")).toContain("skipped");
  });

  it("states when no credential exists and stands on extractor defaults", async () => {
    const root = await fixture();
    const sink = output();
    const result = await runAiExtraction({
      root, output: sink.output, env: {}, yes: false, interactive: true,
      harnesses: [fakeHarness("x", null)],
    });
    expect(result.ran).toBe(false);
    expect(sink.logs.join("\n")).toContain("AI polish: unavailable");
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
});
