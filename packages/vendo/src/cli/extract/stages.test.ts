import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtractionHarness, ExtractionRunInput } from "./harness.js";
import { normalizeSurfaces, runStagedExtraction, type StaticTool } from "./stages.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const TOOLS: StaticTool[] = [
  { name: "host_invoices_list", description: "GET /api/invoices", risk: "read", method: "GET", path: "/api/invoices" },
  { name: "host_invoices_create", description: "POST /api/invoices", risk: "write", method: "POST", path: "/api/invoices" },
  { name: "host_admin_reset", description: "POST /api/admin/reset", risk: "destructive", method: "POST", path: "/api/admin/reset" },
];

async function fixture(brief?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-stages-"));
  cleanup.push(root);
  await mkdir(join(root, ".vendo"), { recursive: true });
  if (brief !== undefined) await writeFile(join(root, ".vendo", "brief.md"), `${brief}\n`);
  return root;
}

/** Identify which stage an instruction string belongs to. */
function stageOf(instructions: string): "survey" | "draft" | "cross-check" | "brief" | "theme" {
  if (instructions.includes("extraction surveyor")) return "survey";
  if (instructions.includes("cross-checker")) return "cross-check";
  if (instructions.includes("drafting the product brief")) return "brief";
  if (instructions.includes("filling the theme's brand slots")) return "theme";
  return "draft";
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

const SURVEY = {
  frameworks: ["next"],
  surfaces: [
    { name: "Invoices", note: "app/api/invoices", tools: ["host_invoices_list", "host_invoices_create"] },
    { name: "Admin", tools: ["host_admin_reset"] },
  ],
};

function draftFor(instructions: string): { tools: Array<{ name: string; description: string }> } {
  const names = TOOLS.map((tool) => tool.name).filter((name) => instructions.includes(name));
  return { tools: names.map((name) => ({ name, description: `drafted: ${name}` })) };
}

async function readArtifact(root: string, stage: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, ".vendo", "data", "extract", `${stage}.json`), "utf8"));
}

describe("runStagedExtraction", () => {
  it("sequences survey → draft-per-surface → cross-check → brief and writes every stage artifact", async () => {
    const root = await fixture();
    const { harness, runs } = scriptedHarness((stage, input) => {
      if (stage === "survey") return SURVEY;
      if (stage === "draft") return draftFor(input.instructions);
      if (stage === "cross-check") {
        return { tools: [{ name: "host_admin_reset", description: "amended: reset all demo data", risk: "destructive" as const, critical: true }] };
      }
      return { brief: "Maple is a consumer bank." };
    });
    const result = await runStagedExtraction({
      root,
      env: { VENDO_EXTRACTION_MODEL: "big-model", VENDO_EXTRACTION_SURVEY_MODEL: "small-model" },
      harness,
      tools: TOOLS,
      appName: "maple",
    });

    expect(runs.map((run) => run.stage)).toEqual(["survey", "draft", "draft", "cross-check", "brief"]);
    // The survey pass runs on its override model; every other stage keeps the base model.
    expect(runs[0]?.input.env["VENDO_EXTRACTION_MODEL"]).toBe("small-model");
    expect(runs.slice(1).every((run) => run.input.env["VENDO_EXTRACTION_MODEL"] === "big-model")).toBe(true);
    // Per-surface passes carry only their own surface's tools.
    expect(runs[1]?.input.instructions).toContain("host_invoices_list");
    expect(runs[1]?.input.instructions).not.toContain("host_admin_reset");

    expect(result.notes).toEqual([]);
    expect(result.briefFromStage).toBe(true);
    expect(result.draft.brief).toBe("Maple is a consumer bank.");
    expect(result.draft.tools).toHaveLength(3);
    expect(result.draft.tools.find((tool) => tool.name === "host_admin_reset")).toMatchObject({
      description: "amended: reset all demo data",
      critical: true,
    });

    const files = await readdir(join(root, ".vendo", "data", "extract"));
    expect(files.sort()).toEqual(["brief.json", "cross-check.json", "draft.admin.json", "draft.invoices.json", "draft.json", "survey.json"]);
    expect(await readArtifact(root, "survey")).toMatchObject({ frameworks: ["next"] });
    expect(await readArtifact(root, "draft")).toMatchObject({ brief: "Maple is a consumer bank." });
  });

  it("a failed surface pass is skipped with an honest note, not fatal", async () => {
    const root = await fixture();
    const { harness } = scriptedHarness((stage, input) => {
      if (stage === "survey") return SURVEY;
      if (stage === "draft" && input.instructions.includes("host_admin_reset")) return new Error("rate limited");
      if (stage === "draft") return draftFor(input.instructions);
      if (stage === "cross-check") return { tools: [] };
      return { brief: "b" };
    });
    const result = await runStagedExtraction({ root, env: {}, harness, tools: TOOLS, appName: "maple" });
    expect(result.draft.tools.map((tool) => tool.name).sort()).toEqual(["host_invoices_create", "host_invoices_list"]);
    expect(result.notes).toEqual(['surface "Admin" skipped (rate limited) — its 1 tools keep extractor defaults']);
    // The failed stage's artifact records the error for diagnosis.
    expect(await readArtifact(root, "draft.admin")).toMatchObject({ stage: "draft.admin", error: "rate limited" });
  });

  it("throws naming the stage when every surface pass fails", async () => {
    const root = await fixture();
    const { harness } = scriptedHarness((stage) => (stage === "survey" ? SURVEY : new Error("model unreachable")));
    await expect(runStagedExtraction({ root, env: {}, harness, tools: TOOLS, appName: "maple" }))
      .rejects.toThrow("draft stage failed for every surface (model unreachable)");
  });

  it("a failed cross-check degrades to the uncross-checked drafts", async () => {
    const root = await fixture();
    const { harness } = scriptedHarness((stage, input) => {
      if (stage === "survey") return SURVEY;
      if (stage === "draft") return draftFor(input.instructions);
      if (stage === "cross-check") return new Error("overloaded");
      return { brief: "b" };
    });
    const result = await runStagedExtraction({ root, env: {}, harness, tools: TOOLS, appName: "maple" });
    expect(result.draft.tools).toHaveLength(3);
    expect(result.draft.tools.every((tool) => tool.description.startsWith("drafted:"))).toBe(true);
    expect(result.notes).toEqual(["cross-check stage failed (overloaded) — using the uncross-checked drafts"]);
  });

  it("cross-check may only amend: unknown names are ignored, omitted entries stand", async () => {
    const root = await fixture();
    const { harness } = scriptedHarness((stage, input) => {
      if (stage === "survey") return SURVEY;
      if (stage === "draft") return draftFor(input.instructions);
      if (stage === "cross-check") {
        return { tools: [
          { name: "host_invoices_list", description: "amended: list invoices" },
          { name: "invented_tool", description: "not drafted by any surface" },
        ] };
      }
      return { brief: "b" };
    });
    const result = await runStagedExtraction({ root, env: {}, harness, tools: TOOLS, appName: "maple" });
    expect(result.draft.tools.map((tool) => tool.name).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
    expect(result.draft.tools.find((tool) => tool.name === "host_invoices_list")?.description).toBe("amended: list invoices");
    expect(result.draft.tools.find((tool) => tool.name === "host_invoices_create")?.description).toBe("drafted: host_invoices_create");
    expect(result.notes).toEqual(['cross-check: amendment for undrafted tool "invented_tool" ignored']);
  });

  it("a description-only amendment merges onto the surface draft, keeping its risk/critical/wake judgment", async () => {
    const root = await fixture();
    const { harness } = scriptedHarness((stage, input) => {
      if (stage === "survey") return SURVEY;
      if (stage === "draft" && input.instructions.includes("host_admin_reset")) {
        return { tools: [{
          name: "host_admin_reset", description: "Reset all demo data.",
          risk: "destructive" as const, critical: true, disabled: false, reasoning: "handler truncates tables",
        }] };
      }
      if (stage === "draft") return draftFor(input.instructions);
      if (stage === "cross-check") return { tools: [{ name: "host_admin_reset", description: "amended: reset demo data" }] };
      return { brief: "b" };
    });
    const result = await runStagedExtraction({ root, env: {}, harness, tools: TOOLS, appName: "maple" });
    expect(result.draft.tools.find((tool) => tool.name === "host_admin_reset")).toEqual({
      name: "host_admin_reset",
      description: "amended: reset demo data",
      risk: "destructive",
      critical: true,
      disabled: false,
      reasoning: "handler truncates tables",
    });
  });

  it("a surface pass drafting another surface's tool is ignored, keeping containment honest", async () => {
    const root = await fixture();
    const { harness } = scriptedHarness((stage, input) => {
      if (stage === "survey") return SURVEY;
      if (stage === "draft" && input.instructions.includes("host_admin_reset")) return new Error("rate limited");
      if (stage === "draft") {
        return { tools: [
          ...draftFor(input.instructions).tools,
          { name: "host_admin_reset", description: "poached from another surface" },
        ] };
      }
      if (stage === "cross-check") return { tools: [] };
      return { brief: "b" };
    });
    const result = await runStagedExtraction({ root, env: {}, harness, tools: TOOLS, appName: "maple" });
    // The admin surface failed, so its tool keeps extractor defaults — the
    // invoices pass cannot smuggle in a draft for it.
    expect(result.draft.tools.map((tool) => tool.name).sort()).toEqual(["host_invoices_create", "host_invoices_list"]);
    expect(result.notes).toContain('surface "Invoices": draft for out-of-surface tool "host_admin_reset" ignored');
  });

  it("a failed survey degrades to drafting everything as one surface", async () => {
    const root = await fixture();
    const { harness, runs } = scriptedHarness((stage, input) => {
      if (stage === "survey") return new Error("bad json");
      if (stage === "draft") return draftFor(input.instructions);
      if (stage === "cross-check") return { tools: [] };
      return { brief: "b" };
    });
    const result = await runStagedExtraction({ root, env: {}, harness, tools: TOOLS, appName: "maple" });
    expect(runs.filter((run) => run.stage === "draft")).toHaveLength(1);
    expect(result.draft.tools).toHaveLength(3);
    expect(result.notes).toEqual(["survey stage failed (bad json) — drafting all 3 tools as one surface"]);
    expect(await readArtifact(root, "survey")).toMatchObject({ stage: "survey", error: "bad json" });
    expect(await readArtifact(root, "draft.all-tools")).toBeDefined();
  });

  it("a failed brief stage keeps the current brief", async () => {
    const root = await fixture("The humans already described this product.");
    const { harness } = scriptedHarness((stage, input) => {
      if (stage === "survey") return SURVEY;
      if (stage === "draft") return draftFor(input.instructions);
      if (stage === "cross-check") return { tools: [] };
      return new Error("timed out");
    });
    const result = await runStagedExtraction({ root, env: {}, harness, tools: TOOLS, appName: "maple" });
    expect(result.briefFromStage).toBe(false);
    expect(result.draft.brief).toBe("The humans already described this product.");
    expect(result.notes).toEqual(["brief stage failed (timed out) — keeping the current brief"]);
  });

  it("runs a theme stage after brief when the theme input needs brand slots, landing the parsed artifact in the result and its artifact file", async () => {
    const root = await fixture();
    const themeArtifact = {
      slots: { accent: "#112233", radius: "8px" },
      uncertain: [{ slot: "accent", note: "two plausible brand colors" }],
    };
    const { harness, runs } = scriptedHarness((stage, input) => {
      if (stage === "survey") return SURVEY;
      if (stage === "draft") return draftFor(input.instructions);
      if (stage === "cross-check") return { tools: [] };
      if (stage === "brief") return { brief: "b" };
      return themeArtifact;
    });
    const result = await runStagedExtraction({
      root,
      env: {},
      harness,
      tools: TOOLS,
      appName: "maple",
      theme: { needed: ["accent", "radius", "density"], alreadyExact: { background: "#ffffff" }, evidencePaths: ["app/globals.css"] },
    });

    expect(runs.map((run) => run.stage)).toEqual(["survey", "draft", "draft", "cross-check", "brief", "theme"]);
    const themeRun = runs.find((run) => run.stage === "theme");
    expect(themeRun?.input.instructions).toContain("app/globals.css");
    // "#ffffff" only appears via alreadyExact input threading — the glossary
    // and rules never mention a literal color, so this can't pass by accident.
    expect(themeRun?.input.instructions).toContain("#ffffff");
    // Slot glossary (the semantics, not just the rules) must survive the port.
    expect(themeRun?.input.instructions).toContain("primary interactive color");
    // Same-role token collisions must be settled by counted dominance or flagged
    // uncertain (live-gate finding: confident wrong mutedText pick on Cadence).
    expect(themeRun?.input.instructions).toContain("COUNT their usages");
    expect(result.theme).toEqual(themeArtifact);
    expect(await readArtifact(root, "theme")).toEqual(themeArtifact);
  });

  it("skips the theme stage when the needed list has no brand slots", async () => {
    const root = await fixture();
    const { harness, runs } = scriptedHarness((stage, input) => {
      if (stage === "survey") return SURVEY;
      if (stage === "draft") return draftFor(input.instructions);
      if (stage === "cross-check") return { tools: [] };
      return { brief: "b" };
    });
    const result = await runStagedExtraction({
      root,
      env: {},
      harness,
      tools: TOOLS,
      appName: "maple",
      theme: { needed: ["density", "motion"], alreadyExact: {}, evidencePaths: [] },
    });
    expect(runs.some((run) => run.stage === "theme")).toBe(false);
    expect(result.theme).toBeUndefined();
  });

  it("skips the theme stage entirely when no theme input is provided", async () => {
    const root = await fixture();
    const { harness, runs } = scriptedHarness((stage, input) => {
      if (stage === "survey") return SURVEY;
      if (stage === "draft") return draftFor(input.instructions);
      if (stage === "cross-check") return { tools: [] };
      return { brief: "b" };
    });
    const result = await runStagedExtraction({ root, env: {}, harness, tools: TOOLS, appName: "maple" });
    expect(runs.some((run) => run.stage === "theme")).toBe(false);
    expect(result.theme).toBeUndefined();
  });

  it("a theme stage failure degrades to a note, never throws, and the rest of the result is intact", async () => {
    const root = await fixture();
    const { harness } = scriptedHarness((stage, input) => {
      if (stage === "survey") return SURVEY;
      if (stage === "draft") return draftFor(input.instructions);
      if (stage === "cross-check") return { tools: [] };
      if (stage === "brief") return { brief: "b" };
      return new Error("model unreachable");
    });
    const result = await runStagedExtraction({
      root,
      env: {},
      harness,
      tools: TOOLS,
      appName: "maple",
      theme: { needed: ["accent"], alreadyExact: {}, evidencePaths: [] },
    });
    expect(result.theme).toBeUndefined();
    expect(result.notes).toEqual(["theme stage failed (model unreachable) — exact reads and defaults stand"]);
    expect(result.draft.tools).toHaveLength(3);
    expect(result.briefFromStage).toBe(true);
    expect(await readArtifact(root, "theme")).toMatchObject({ stage: "theme", error: "model unreachable" });
  });

  it("clears artifacts from a previous run before starting", async () => {
    const root = await fixture();
    await mkdir(join(root, ".vendo", "data", "extract"), { recursive: true });
    await writeFile(join(root, ".vendo", "data", "extract", "draft.stale-surface.json"), "{}");
    const { harness } = scriptedHarness((stage, input) => {
      if (stage === "survey") return SURVEY;
      if (stage === "draft") return draftFor(input.instructions);
      if (stage === "cross-check") return { tools: [] };
      return { brief: "b" };
    });
    await runStagedExtraction({ root, env: {}, harness, tools: TOOLS, appName: "maple" });
    const files = await readdir(join(root, ".vendo", "data", "extract"));
    expect(files).not.toContain("draft.stale-surface.json");
  });
});

describe("normalizeSurfaces", () => {
  it("drops unknown names, keeps first assignment, and sweeps unassigned tools into a catch-all", () => {
    const notes: string[] = [];
    const surfaces = normalizeSurfaces(
      { surfaces: [
        { name: "Invoices", tools: ["host_invoices_list", "ghost_tool"] },
        { name: "Also invoices", tools: ["host_invoices_list"] },
      ] },
      TOOLS,
      notes,
    );
    expect(surfaces.map((surface) => surface.name)).toEqual(["Invoices", "everything else"]);
    expect(surfaces[1]?.tools.map((tool) => tool.name).sort()).toEqual(["host_admin_reset", "host_invoices_create"]);
    expect(notes.some((note) => note.includes('"ghost_tool"'))).toBe(true);
    expect(notes.some((note) => note.includes("2 tools unassigned"))).toBe(true);
  });

  it("merges a runaway surface count into one tail pass and dedupes slugs", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ name: `t${index}`, description: "d" }));
    const notes: string[] = [];
    const surfaces = normalizeSurfaces(
      { surfaces: many.map((tool) => ({ name: "Same Name!", tools: [tool.name] })) },
      many,
      notes,
    );
    expect(surfaces).toHaveLength(12);
    expect(surfaces[11]?.tools).toHaveLength(9);
    expect(new Set(surfaces.map((surface) => surface.slug)).size).toBe(12);
    expect(notes.some((note) => note.includes("merged the tail"))).toBe(true);
  });
});
