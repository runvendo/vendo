import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtractionHarness, ExtractionRunInput } from "../extract/harness.js";
import type { StaticTool } from "../extract/stages.js";
import { exists } from "../shared.js";
import { runDeepening } from "./deepen.js";
import { assembleTryProfile } from "./profile.js";
import { createTryEventBus, type TryEventBus } from "./server.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(root);
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = join(root, relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source, "utf8");
}

const TOOLS: StaticTool[] = [
  { name: "host_invoices_list", description: "GET /api/invoices", risk: "read", method: "GET", path: "/api/invoices" },
  { name: "host_invoices_create", description: "POST /api/invoices", risk: "write", method: "POST", path: "/api/invoices" },
];

/** The same tools as the deterministic pass writes them: full vendo/tools@3
 *  entries (descriptor + binding), so assembleTryProfile counts them too. */
const EXTRACTED_TOOLS = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  risk: tool.risk,
  inputSchema: { type: "object", properties: {} },
  binding: { kind: "route", method: tool.method, path: tool.path, argsIn: tool.method === "GET" ? "query" : "body" },
}));

/** The host repo the harness may EXPLORE but never write to. */
async function hostRepo(): Promise<string> {
  const root = await tempDir("vendo-deepen-repo-");
  await write(root, "package.json", `${JSON.stringify({ name: "maple" })}\n`);
  await write(root, "app/api/invoices/route.ts", "export async function GET() { return Response.json([]); }\n");
  return root;
}

/** A profile root as the deterministic pass (Task 2) leaves it: tools.json
 *  landed, no brief, no overrides, no seeds artifacts yet. */
async function seededProfileRoot(): Promise<string> {
  const root = await tempDir("vendo-deepen-profile-");
  await write(root, join(".vendo", "tools.json"), `${JSON.stringify({ format: "vendo/tools@3", tools: EXTRACTED_TOOLS })}\n`);
  return root;
}

/** Full recursive inventory of a tree (extract.test.ts's zero-commit unit). */
async function inventory(root: string, at = root): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const path = join(at, entry.name);
    const relative = path.slice(root.length + 1);
    if (entry.isDirectory()) {
      entries[`${relative}/`] = "dir";
      Object.assign(entries, await inventory(root, path));
    } else {
      entries[relative] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  return entries;
}

type DeepStage = "survey" | "draft" | "cross-check" | "brief" | "seeds";

/** Identify which pass an instruction string belongs to (stages.test.ts's
 *  markers plus the seeds pass's). */
function stageOf(instructions: string): DeepStage {
  if (instructions.includes("extraction surveyor")) return "survey";
  if (instructions.includes("cross-checker")) return "cross-check";
  if (instructions.includes("drafting the product brief")) return "brief";
  if (instructions.includes("try-surface seeder")) return "seeds";
  return "draft";
}

/** A scripted harness: responds per pass, records every run. */
function scriptedHarness(
  respond: (stage: DeepStage, input: ExtractionRunInput) => object | Error,
  availability: string | null = "a scripted fake",
): { harness: ExtractionHarness; runs: Array<{ stage: DeepStage; input: ExtractionRunInput }> } {
  const runs: Array<{ stage: DeepStage; input: ExtractionRunInput }> = [];
  return {
    runs,
    harness: {
      id: "scripted",
      availability: async () => availability,
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
  surfaces: [{ name: "Invoices", note: "app/api/invoices", tools: TOOLS.map((tool) => tool.name) }],
};

const DRAFT = {
  tools: TOOLS.map((tool) => ({ name: tool.name, description: `drafted: ${tool.name}` })),
};

const BRIEF = { brief: "Maple is a consumer bank for freelancers." };

const SEEDS = {
  usecases: [
    { label: "Chase overdue invoices", prompt: "Show my overdue invoices and draft reminders" },
    { label: "Create an invoice", prompt: "Help me create a new invoice" },
    { label: "Spending overview", prompt: "Visualize my spending this quarter" },
  ],
  fixtures: {
    host_invoices_list: [{ id: "inv_001", customer: "Ada Lovelace", amountCents: 12500 }],
  },
};

/** The default script: every pass answers. */
function happyScript(stage: DeepStage): object | Error {
  if (stage === "survey") return SURVEY;
  if (stage === "draft") return DRAFT;
  if (stage === "cross-check") return { tools: [] };
  if (stage === "brief") return BRIEF;
  return SEEDS;
}

/** Collect `{ type: "stage" }` events off the bus as `"<stage> <status>"`. */
function recordStages(events: TryEventBus): string[] {
  const seen: string[] = [];
  events.subscribe((event) => {
    if (event.type === "stage") seen.push(`${String(event["stage"])} ${String(event["status"])}`);
  });
  return seen;
}

describe("runDeepening", () => {
  it("happy path: artifacts land under profileRoot only, events pair up in order, summary and bus stages are truthful", async () => {
    const repoRoot = await hostRepo();
    const profileRoot = await seededProfileRoot();
    const before = await inventory(repoRoot);
    const events = createTryEventBus();
    const seen = recordStages(events);
    const { harness, runs } = scriptedHarness(happyScript);

    const summary = await runDeepening({ repoRoot, profileRoot, events, env: {}, harnesses: [harness] });

    expect(summary).toEqual({ extraction: "ran", seeds: "written", engine: "scripted" });

    // Zero-commit: the host repo is byte-for-byte untouched.
    expect(await inventory(repoRoot)).toEqual(before);

    // The write-root split, both sides: extraction stages EXPLORE the host
    // repo; the seeds pass runs in the profile root (its own contract).
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.input.root).toBe(run.stage === "seeds" ? profileRoot : repoRoot);
    }

    // Every artifact landed under profileRoot: the apply outputs and the
    // per-stage artifacts, seeds included.
    const overrides = JSON.parse(await readFile(join(profileRoot, ".vendo", "overrides.json"), "utf8"));
    expect(overrides.tools["host_invoices_list"]).toMatchObject({ description: "drafted: host_invoices_list" });
    expect(await readFile(join(profileRoot, ".vendo", "brief.md"), "utf8")).toContain("consumer bank");
    const artifacts = await readdir(join(profileRoot, ".vendo", "data", "extract"));
    expect(artifacts.sort()).toEqual([
      "brief.json", "cross-check.json", "draft.invoices.json", "draft.json",
      "fixtures.json", "survey.json", "usecases.json",
    ]);

    // Events arrive in order with started/terminal pairs for every stage.
    expect(seen).toEqual([
      "survey started", "survey done",
      "drafts started", "drafts done",
      "cross-check started", "cross-check done",
      "brief started", "brief done",
      "seeds started", "seeds done",
    ]);

    // The bus's end-state is exactly what /profile.json would report: the
    // live stage overrides ride on top of the disk-derived defaults.
    expect(events.stages()).toEqual({
      survey: "done", drafts: "done", "cross-check": "done", brief: "done", seeds: "done",
    });
    const profile = await assembleTryProfile(profileRoot, { stages: events.stages() });
    expect(profile.depth.level).toBe("deep");
    expect(profile.depth.stages).toMatchObject({
      tools: "done", survey: "done", drafts: "done", "cross-check": "done", brief: "done", seeds: "done",
    });
    expect(profile.usecases).toEqual(SEEDS.usecases);
  });

  it("no harness available: skipped events + skipped summary, nothing written, no throw", async () => {
    const repoRoot = await hostRepo();
    const profileRoot = await seededProfileRoot();
    const beforeRepo = await inventory(repoRoot);
    const beforeProfile = await inventory(profileRoot);
    const events = createTryEventBus();
    const seen = recordStages(events);
    const { harness, runs } = scriptedHarness(happyScript, null);

    const summary = await runDeepening({ repoRoot, profileRoot, events, env: {}, harnesses: [harness] });

    expect(summary).toEqual({ extraction: "skipped", seeds: "skipped" });
    expect(runs).toEqual([]);
    expect(seen).toEqual([
      "survey skipped", "drafts skipped", "cross-check skipped", "brief skipped", "seeds skipped",
    ]);
    expect(await inventory(repoRoot)).toEqual(beforeRepo);
    expect(await inventory(profileRoot)).toEqual(beforeProfile);
  });

  it("an unavailable --engine pin skips (never falls back to another provider)", async () => {
    const repoRoot = await hostRepo();
    const profileRoot = await seededProfileRoot();
    const events = createTryEventBus();
    const { harness, runs } = scriptedHarness(happyScript);

    const summary = await runDeepening({
      repoRoot, profileRoot, events, env: {}, engine: "claude", harnesses: [harness],
    });

    expect(summary).toEqual({ extraction: "skipped", seeds: "skipped" });
    expect(runs).toEqual([]);
    expect(events.stages()["seeds"]).toBe("skipped");
  });

  it("missing tools.json (deterministic sync failed): everything skips, nothing written", async () => {
    const repoRoot = await hostRepo();
    const profileRoot = await tempDir("vendo-deepen-profile-");
    const events = createTryEventBus();
    const { harness, runs } = scriptedHarness(happyScript);

    const summary = await runDeepening({ repoRoot, profileRoot, events, env: {}, harnesses: [harness] });

    expect(summary).toEqual({ extraction: "skipped", seeds: "skipped" });
    expect(runs).toEqual([]);
    expect(await exists(join(profileRoot, ".vendo"))).toBe(false);
  });

  it("a survey failure degrades (runStagedExtraction's contract) — extraction still ran, seeds still written, events truthful", async () => {
    const repoRoot = await hostRepo();
    const profileRoot = await seededProfileRoot();
    const events = createTryEventBus();
    const seen = recordStages(events);
    const { harness } = scriptedHarness((stage) =>
      stage === "survey" ? new Error("bad json") : happyScript(stage));

    const summary = await runDeepening({ repoRoot, profileRoot, events, env: {}, harnesses: [harness] });

    expect(summary).toEqual({ extraction: "ran", seeds: "written", engine: "scripted" });
    expect(seen).toEqual([
      "survey started", "survey failed",
      "drafts started", "drafts done",
      "cross-check started", "cross-check done",
      "brief started", "brief done",
      "seeds started", "seeds done",
    ]);
    expect(events.stages()).toMatchObject({ survey: "failed", brief: "done", seeds: "done" });
    expect(await exists(join(profileRoot, ".vendo", "brief.md"))).toBe(true);
    expect(await exists(join(profileRoot, ".vendo", "data", "extract", "usecases.json"))).toBe(true);
  });

  it("every draft surface failing fails extraction; seeds still run on the tools with a null brief", async () => {
    const repoRoot = await hostRepo();
    const profileRoot = await seededProfileRoot();
    const before = await inventory(repoRoot);
    const events = createTryEventBus();
    const seen = recordStages(events);
    const { harness, runs } = scriptedHarness((stage) =>
      stage === "seeds" ? SEEDS : new Error("model unreachable"));

    const summary = await runDeepening({ repoRoot, profileRoot, events, env: {}, harnesses: [harness] });

    expect(summary).toEqual({ extraction: "failed", seeds: "written", engine: "scripted" });
    expect(seen).toEqual([
      "survey started", "survey failed",
      "drafts started", "drafts failed",
      "cross-check skipped", "brief skipped",
      "seeds started", "seeds done",
    ]);
    // No brief landed, so the seeds pass composes the null-brief instructions.
    const seedsRun = runs.find((run) => run.stage === "seeds");
    expect(seedsRun?.input.instructions).toContain("unknown product");
    expect(await exists(join(profileRoot, ".vendo", "brief.md"))).toBe(false);
    // Zero-commit holds on the failure path too.
    expect(await inventory(repoRoot)).toEqual(before);
  });

  it("a seeds failure leaves extraction artifacts intact, carries a failed event, writes no seed artifact", async () => {
    const repoRoot = await hostRepo();
    const profileRoot = await seededProfileRoot();
    const events = createTryEventBus();
    const seen = recordStages(events);
    const { harness } = scriptedHarness((stage) =>
      stage === "seeds" ? new Error("model unreachable") : happyScript(stage));

    const summary = await runDeepening({ repoRoot, profileRoot, events, env: {}, harnesses: [harness] });

    expect(summary).toEqual({ extraction: "ran", seeds: "failed", engine: "scripted" });
    expect(seen.slice(-2)).toEqual(["seeds started", "seeds failed"]);
    expect(events.stages()["seeds"]).toBe("failed");
    // Extraction's artifacts stand; seeds wrote nothing (its own guarantee).
    expect(await exists(join(profileRoot, ".vendo", "overrides.json"))).toBe(true);
    expect(await exists(join(profileRoot, ".vendo", "brief.md"))).toBe(true);
    expect(await exists(join(profileRoot, ".vendo", "data", "extract", "usecases.json"))).toBe(false);
    expect(await exists(join(profileRoot, ".vendo", "data", "extract", "fixtures.json"))).toBe(false);
  });

  it("is safe to fire-and-forget: an unexpected throw (broken availability) resolves to a failed summary", async () => {
    const repoRoot = await hostRepo();
    const profileRoot = await seededProfileRoot();
    const events = createTryEventBus();
    const broken: ExtractionHarness = {
      id: "broken",
      availability: async () => { throw new Error("availability exploded"); },
      run: async () => "never",
    };

    const summary = await runDeepening({ repoRoot, profileRoot, events, env: {}, harnesses: [broken] });

    expect(summary).toEqual({ extraction: "failed", seeds: "failed" });
    expect(events.stages()).toMatchObject({ seeds: "failed" });
  });
});
