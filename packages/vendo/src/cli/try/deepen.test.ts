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

type DeepStage = "judge" | "skeptic" | "brief" | "seeds";

/** Identify which pass an instruction string belongs to. */
function stageOf(instructions: string): DeepStage {
  if (instructions.includes("judgment SKEPTIC")) return "skeptic";
  if (instructions.includes("judgment agent")) return "judge";
  if (instructions.includes("try-surface seeder")) return "seeds";
  return "brief";
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

/** Prose-only proposals: no direction, so they apply themselves and no
 *  loosening can queue — which is what a non-interactive `vendo try` needs. */
const JUDGE = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: `judged: ${tool.name}`,
    evidence: `export async function ${tool.method}() {`,
  })),
  narrative: "both handlers read invoices",
};

const SKEPTIC = {
  verdicts: TOOLS.map((tool) => ({ name: tool.name, field: "description", verdict: "uphold" })),
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
  if (stage === "judge") return JUDGE;
  if (stage === "skeptic") return SKEPTIC;
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

    // The write-root split, both sides: the judgment and brief passes EXPLORE
    // the host repo; the seeds pass runs in the profile root (its own contract).
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.input.root).toBe(run.stage === "seeds" ? profileRoot : repoRoot);
    }

    // Judgment landed in the judgments channel — never in overrides.json, which
    // stays the human's file, and never in the deterministic tools.json.
    const judgments = JSON.parse(await readFile(join(profileRoot, ".vendo", "judgments.json"), "utf8"));
    expect(judgments.tools["host_invoices_list"]).toMatchObject({
      binding: "GET /api/invoices",
      fields: { description: "judged: host_invoices_list" },
    });
    expect(await exists(join(profileRoot, ".vendo", "overrides.json"))).toBe(false);

    expect(await readFile(join(profileRoot, ".vendo", "brief.md"), "utf8")).toContain("consumer bank");
    expect((await readdir(join(profileRoot, ".vendo", "data", "extract"))).sort())
      .toEqual(["brief.json", "fixtures.json", "usecases.json"]);
    // The judgment pass keeps its own stage artifacts.
    expect((await readdir(join(profileRoot, ".vendo", "data", "judge"))).length).toBeGreaterThan(0);

    // Events arrive in order with started/terminal pairs for every stage.
    expect(seen).toEqual([
      "judgment started", "judgment done",
      "brief started", "brief done",
      "seeds started", "seeds done",
    ]);

    // The bus's end-state is exactly what /profile.json would report: the
    // live stage overrides ride on top of the disk-derived defaults.
    expect(events.stages()).toEqual({ judgment: "done", brief: "done", seeds: "done" });
    const profile = await assembleTryProfile(profileRoot, { stages: events.stages() });
    expect(profile.depth.level).toBe("deep");
    expect(profile.depth.stages).toMatchObject({
      tools: "done", judgment: "done", brief: "done", seeds: "done",
    });
    expect(profile.usecases).toEqual(SEEDS.usecases);
    // The judged description reaches the rendered profile through the display
    // merge (skeleton ⊕ judgments ⊕ overrides).
    expect(profile.tools.list.find((tool) => tool.name === "host_invoices_list")?.description)
      .toBe("judged: host_invoices_list");
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
    expect(seen).toEqual(["judgment skipped", "brief skipped", "seeds skipped"]);
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

  it("loosenings QUEUE rather than prompting: a non-interactive try never auto-applies one", async () => {
    const repoRoot = await hostRepo();
    const profileRoot = await tempDir("vendo-deepen-profile-");
    // A scanner-disabled tool the judge wants to wake — the clearest loosening.
    await write(profileRoot, join(".vendo", "tools.json"), `${JSON.stringify({
      format: "vendo/tools@3",
      tools: [{ ...EXTRACTED_TOOLS[0], disabled: true }],
    })}\n`);
    const events = createTryEventBus();
    const { harness } = scriptedHarness((stage) => {
      if (stage === "judge") {
        return {
          tools: [{
            name: "host_invoices_list",
            disabled: false,
            evidence: "export async function GET() {",
          }],
          narrative: "",
        };
      }
      if (stage === "skeptic") {
        return { verdicts: [{ name: "host_invoices_list", field: "disabled", verdict: "uphold" }] };
      }
      return happyScript(stage);
    });

    const summary = await runDeepening({ repoRoot, profileRoot, events, env: {}, harnesses: [harness] });

    expect(summary.extraction).toBe("ran");
    const judgments = JSON.parse(await readFile(join(profileRoot, ".vendo", "judgments.json"), "utf8"));
    // Queued as pending, NOT applied: the tool is still disabled at runtime.
    expect(judgments.tools["host_invoices_list"].fields.disabled).toBeUndefined();
    expect(judgments.tools["host_invoices_list"].pending)
      .toEqual([expect.objectContaining({ field: "disabled", value: false })]);
    const profile = await assembleTryProfile(profileRoot);
    expect(profile.tools.list[0]?.disabled).toBe(true);
  });

  it("an unusable judge reply degrades to a SKIPPED judgment stage; brief and seeds still run", async () => {
    const repoRoot = await hostRepo();
    const profileRoot = await seededProfileRoot();
    const events = createTryEventBus();
    const seen = recordStages(events);
    const { harness } = scriptedHarness((stage) =>
      stage === "judge" ? new Error("model unreachable") : happyScript(stage));

    const summary = await runDeepening({ repoRoot, profileRoot, events, env: {}, harnesses: [harness] });

    // The pass is fail-soft, so deepening as a whole still ran — but the stream
    // must not claim the judgment stage finished when nothing was judged.
    expect(summary).toEqual({ extraction: "ran", seeds: "written", engine: "scripted" });
    expect(seen).toEqual([
      "judgment started", "judgment skipped",
      "brief started", "brief done",
      "seeds started", "seeds done",
    ]);
    expect(await exists(join(profileRoot, ".vendo", "judgments.json"))).toBe(false);
    expect(await exists(join(profileRoot, ".vendo", "brief.md"))).toBe(true);
    expect(await exists(join(profileRoot, ".vendo", "data", "extract", "usecases.json"))).toBe(true);
  });

  it("a brief failure carries a failed event; seeds still run with a null brief", async () => {
    const repoRoot = await hostRepo();
    const profileRoot = await seededProfileRoot();
    const before = await inventory(repoRoot);
    const events = createTryEventBus();
    const seen = recordStages(events);
    const { harness, runs } = scriptedHarness((stage) =>
      stage === "brief" ? new Error("model unreachable") : happyScript(stage));

    const summary = await runDeepening({ repoRoot, profileRoot, events, env: {}, harnesses: [harness] });

    expect(summary).toEqual({ extraction: "ran", seeds: "written", engine: "scripted" });
    expect(seen).toEqual([
      "judgment started", "judgment done",
      "brief started", "brief failed",
      "seeds started", "seeds done",
    ]);
    // No brief landed, so the seeds pass composes the null-brief instructions.
    expect(runs.find((run) => run.stage === "seeds")?.input.instructions).toContain("unknown product");
    expect(await exists(join(profileRoot, ".vendo", "brief.md"))).toBe(false);
    // Zero-commit holds on the failure path too.
    expect(await inventory(repoRoot)).toEqual(before);
  });

  it("a seeds failure leaves the earlier artifacts intact, carries a failed event, writes no seed artifact", async () => {
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
    // The judgment and brief artifacts stand; seeds wrote nothing (its own
    // guarantee).
    expect(await exists(join(profileRoot, ".vendo", "judgments.json"))).toBe(true);
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
