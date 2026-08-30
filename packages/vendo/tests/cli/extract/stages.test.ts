import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtractionHarness, ExtractionRunInput } from "../../../src/cli/extract/harness.js";
import { BRIEF_TEMPLATE, applyBrief, runBriefStage, runThemeStage, staticFacts, type StaticTool } from "../../../src/cli/extract/stages.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const TOOLS: StaticTool[] = [
  { name: "host_invoices_list", description: "GET /api/invoices", risk: "read", method: "GET", path: "/api/invoices" },
];

/** What the judgment pass settled, as the brief stage now consumes it. */
const JUDGED = [
  { name: "host_invoices_list", description: "List the invoices the signed-in customer owns." },
  { name: "host_admin_reset", description: "Wipe every invoice — staff console only." },
];

async function fixture(brief?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-stages-"));
  cleanup.push(root);
  await mkdir(join(root, ".vendo"), { recursive: true });
  if (brief !== undefined) await writeFile(join(root, ".vendo", "brief.md"), `${brief}\n`);
  return root;
}

/** Identify which stage an instruction string belongs to. */
function stageOf(instructions: string): "brief" | "theme" {
  return instructions.includes("filling the theme's brand slots") ? "theme" : "brief";
}

/** A scripted harness: responds per stage, records every run. */
function scriptedHarness(
  respond: (stage: string, input: ExtractionRunInput) => object | Error,
): { harness: ExtractionHarness; runs: Array<{ stage: string; input: ExtractionRunInput }> } {
  const runs: Array<{ stage: string; input: ExtractionRunInput }> = [];
  return {
    runs,
    harness: {
      id: "scripted",
      availability: async () => "a scripted fake",
      run: async (input) => {
        const stage = stageOf(input.instructions);
        runs.push({ stage, input });
        const response = respond(stage, input);
        if (response instanceof Error) throw response;
        return "```json\n" + JSON.stringify(response) + "\n```";
      },
    },
  };
}

async function readArtifact(root: string, stage: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, ".vendo", "data", "extract", `${stage}.json`), "utf8"));
}

describe("runBriefStage", () => {
  it("drafts the brief from the JUDGED name+description pairs and writes the stage artifact", async () => {
    const root = await fixture();
    const { harness, runs } = scriptedHarness(() => ({ brief: "Maple is a bank." }));

    const result = await runBriefStage({ root, env: {}, harness, appName: "maple", judged: JUDGED });

    expect(result).toEqual({ brief: "Maple is a bank.", fromStage: true, notes: [] });
    expect(runs.map((run) => run.stage)).toEqual(["brief"]);
    // The judged descriptions are what the prompt carries — the judgment pass
    // has already replaced the extractor's "GET /api/invoices" strings.
    expect(runs[0]?.input.instructions).toContain("List the invoices the signed-in customer owns.");
    expect(runs[0]?.input.instructions).not.toContain("GET /api/invoices");
    expect(await readArtifact(root, "brief")).toEqual({ brief: "Maple is a bank." });
  });

  it("a failed brief stage keeps the current brief", async () => {
    const root = await fixture("The humans already described this product.");
    const { harness } = scriptedHarness(() => new Error("timed out"));

    const result = await runBriefStage({ root, env: {}, harness, appName: "maple", judged: JUDGED });

    expect(result.fromStage).toBe(false);
    expect(result.brief).toBe("The humans already described this product.");
    // The raw parser error alone read as a broken install. It says what broke
    // (the polish, not the install), that the install stands, and how to retry.
    expect(result.notes).toEqual([
      "the AI polish for your brief did not finish (timed out) — your install is "
      + "complete and valid with the default brief; run `vendo sync --ai` to try the polish again",
    ]);
  });

  it("falls back to the template when the stage fails and no brief exists yet", async () => {
    const root = await fixture();
    const { harness } = scriptedHarness(() => new Error("timed out"));

    const result = await runBriefStage({ root, env: {}, harness, appName: "maple", judged: JUDGED });

    expect(result.fromStage).toBe(false);
    expect(result.brief).toBe(BRIEF_TEMPLATE);
  });

  it("artifactRoot splits the writes from the explored root; the harness still explores root", async () => {
    const root = await fixture("the HOST repo's brief — must never be read");
    const artifactRoot = await fixture("the profile's current brief");
    const { harness, runs } = scriptedHarness(() => ({ brief: "drafted" }));

    await runBriefStage({ root, artifactRoot, env: {}, harness, appName: "maple", judged: JUDGED });

    expect(runs[0]?.input.root).toBe(root);
    expect(await readArtifact(artifactRoot, "brief")).toEqual({ brief: "drafted" });
    await expect(readArtifact(root, "brief")).rejects.toThrow();
  });

  it("the failed-brief fallback reads the artifactRoot's brief, not the explored root's", async () => {
    const root = await fixture("the HOST repo's brief — must never be read");
    const artifactRoot = await fixture("the profile's current brief");
    const { harness } = scriptedHarness(() => new Error("timed out"));

    const result = await runBriefStage({ root, artifactRoot, env: {}, harness, appName: "maple", judged: JUDGED });

    expect(result.fromStage).toBe(false);
    expect(result.brief).toBe("the profile's current brief");
  });

  it("records the failure artifact so a failed stage stays diagnosable", async () => {
    const root = await fixture();
    const { harness } = scriptedHarness(() => new Error("timed out"));

    await runBriefStage({ root, env: {}, harness, appName: "maple", judged: JUDGED });

    expect(await readArtifact(root, "brief")).toMatchObject({ stage: "brief", error: "timed out" });
  });
});

describe("runThemeStage", () => {
  const themeArtifact = {
    slots: { accent: "#112233", radius: "8px" },
    uncertain: [{ slot: "accent", note: "two plausible brand colors" }],
  };

  it("fills brand slots, landing the parsed artifact in the result and its artifact file", async () => {
    const root = await fixture();
    const { harness, runs } = scriptedHarness(() => themeArtifact);

    const result = await runThemeStage({
      root,
      env: {},
      harness,
      appName: "maple",
      needed: ["accent", "radius", "density"],
      alreadyExact: { background: "#ffffff" },
      evidencePaths: ["app/globals.css"],
    });

    expect(runs.map((run) => run.stage)).toEqual(["theme"]);
    expect(runs[0]?.input.instructions).toContain("app/globals.css");
    // "#ffffff" only appears via alreadyExact input threading — the glossary
    // and rules never mention a literal color, so this can't pass by accident.
    expect(runs[0]?.input.instructions).toContain("#ffffff");
    // Slot glossary (the semantics, not just the rules) must survive the port.
    expect(runs[0]?.input.instructions).toContain("primary interactive color");
    // Same-role token collisions must be settled by counted dominance or flagged
    // uncertain (live-gate finding: confident wrong mutedText pick on Cadence).
    expect(runs[0]?.input.instructions).toContain("COUNT their usages");
    expect(result).toEqual({ theme: themeArtifact, notes: [] });
    expect(await readArtifact(root, "theme")).toEqual(themeArtifact);
  });

  it("skips the stage when the needed list has no brand slots", async () => {
    const root = await fixture();
    const { harness, runs } = scriptedHarness(() => themeArtifact);

    const result = await runThemeStage({
      root,
      env: {},
      harness,
      appName: "maple",
      needed: ["accentText", "density", "motion"],
      alreadyExact: {},
      evidencePaths: [],
    });

    expect(runs).toEqual([]);
    expect(result).toEqual({ notes: [] });
  });

  it("a failure degrades to a note and never throws", async () => {
    const root = await fixture();
    const { harness } = scriptedHarness(() => new Error("timed out"));

    const result = await runThemeStage({
      root,
      env: {},
      harness,
      appName: "maple",
      needed: ["accent"],
      alreadyExact: {},
      evidencePaths: [],
    });

    expect(result.theme).toBeUndefined();
    expect(result.notes).toEqual(["theme stage failed (timed out) — exact reads and defaults stand"]);
  });
});

describe("applyBrief", () => {
  it("writes the drafted brief over the init template", async () => {
    const root = await fixture(BRIEF_TEMPLATE);
    expect(await applyBrief(root, "the real brief", false)).toBe(true);
    expect(await readFile(join(root, ".vendo", "brief.md"), "utf8")).toBe("the real brief\n");
  });

  it("never replaces a hand-written brief without force", async () => {
    const root = await fixture("a human wrote this");
    expect(await applyBrief(root, "the model's brief", false)).toBe(false);
    expect(await readFile(join(root, ".vendo", "brief.md"), "utf8")).toBe("a human wrote this\n");
    expect(await applyBrief(root, "the model's brief", true)).toBe(true);
  });
});

describe("staticFacts", () => {
  it("projects the fields the prompts need, keeping disabled explicit", () => {
    const facts = JSON.parse(staticFacts([{ ...TOOLS[0]!, disabled: true }])) as Array<Record<string, unknown>>;
    expect(facts[0]).toEqual({
      name: "host_invoices_list",
      method: "GET",
      path: "/api/invoices",
      risk: "read",
      disabled: true,
      description: "GET /api/invoices",
    });
  });
});
