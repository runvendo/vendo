import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtractionHarness } from "@vendoai/vendo/extract";
import {
  DEFAULT_MODEL_LABEL,
  buildAiScoreboard,
  evaluateDraft,
  modelDirName,
  readRepoStaticContext,
  renderAiScoreboardMarkdown,
  runAiRepoMatrix,
  type AiRepoResult,
} from "./matrix.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

const toolsFile = {
  format: "vendo/tools@1",
  tools: [
    {
      name: "host_api_invoices_get",
      description: "GET /api/invoices",
      inputSchema: { type: "object" },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" },
    },
    {
      name: "host_api_invoices_id_delete",
      description: "DELETE /api/invoices/{id}",
      inputSchema: { type: "object" },
      risk: "write",
      binding: { kind: "route", method: "DELETE", path: "/api/invoices/{id}", argsIn: "body" },
    },
  ],
};

async function makeAppRoot(): Promise<string> {
  const appRoot = await makeTempDir("vendo-corpus-ai-app-");
  await mkdir(path.join(appRoot, ".vendo"), { recursive: true });
  await writeFile(path.join(appRoot, ".vendo", "tools.json"), JSON.stringify(toolsFile));
  await writeFile(path.join(appRoot, "package.json"), JSON.stringify({ name: "invoicer" }));
  return appRoot;
}

async function makeExpectationsRoot(withLabels: boolean): Promise<string> {
  const root = await makeTempDir("vendo-corpus-ai-exp-");
  if (withLabels) {
    await mkdir(path.join(root, "invoicer"), { recursive: true });
    await writeFile(path.join(root, "invoicer", "ai-expected.json"), JSON.stringify({
      version: 1,
      tools: [
        { name: "listInvoices", method: "GET", path: "/api/invoices", risk: "read" },
        { name: "deleteInvoice", method: "DELETE", path: "/api/invoices/{id}", risk: "destructive", critical: true },
      ],
    }));
  }
  return root;
}

const goodBrief = "Invoicer is a small invoicing product; users list their invoices and clean up old ones. The agent should help find invoices and delete stale drafts carefully.";

const goodDraftTools = [
  { name: "host_api_invoices_get", description: "List the user's invoices with totals and status." },
  {
    name: "host_api_invoices_id_delete",
    description: "Permanently delete one invoice by id; cannot be undone.",
    risk: "destructive" as const,
    critical: true,
  },
];

const goodDraft = { brief: goodBrief, tools: goodDraftTools };

function fenced(value: unknown): string {
  return ["```json", JSON.stringify(value), "```"].join("\n");
}

/** Answer each staged-pipeline pass with a canned artifact. */
function stagedAnswers(instructions: string): string {
  if (instructions.includes("extraction surveyor")) {
    return fenced({ surfaces: [{ name: "invoices", tools: ["host_api_invoices_get", "host_api_invoices_id_delete"] }] });
  }
  if (instructions.includes("cross-checker")) return fenced({ tools: [] });
  if (instructions.includes("drafting the product brief")) return fenced({ brief: goodBrief });
  return fenced({ tools: goodDraftTools });
}

describe("readRepoStaticContext", () => {
  it("maps tools.json into pipeline and scoring shapes with binding identities", async () => {
    const appRoot = await makeAppRoot();
    const statics = await readRepoStaticContext(appRoot);

    expect(statics.appName).toBe("invoicer");
    expect(statics.forPipeline[0]).toMatchObject({ name: "host_api_invoices_get", method: "GET", path: "/api/invoices" });
    expect(statics.forScoring[1]?.identity).toBe("DELETE\t/api/invoices/{id}");
  });

  it("throws a clear error when tools.json is absent", async () => {
    const appRoot = await makeTempDir("vendo-corpus-ai-empty-");
    await expect(readRepoStaticContext(appRoot)).rejects.toThrow(/tools\.json/);
  });
});

describe("evaluateDraft", () => {
  it("runs a canned draft through the real guards and scores it", async () => {
    const appRoot = await makeAppRoot();
    const scratchRoot = await makeTempDir("vendo-corpus-ai-scratch-");
    const statics = await readRepoStaticContext(appRoot);

    const score = await evaluateDraft({
      draft: goodDraft,
      statics,
      expected: {
        version: 1,
        tools: [
          { name: "listInvoices", method: "GET", path: "/api/invoices", risk: "read" },
          { name: "deleteInvoice", method: "DELETE", path: "/api/invoices/{id}", risk: "destructive", critical: true },
        ],
      },
      scratchRoot,
    });

    expect(score.hardFailure).toBe(false);
    expect(score.score.value).toBe(1);
  });

  it("floors the score when the pipeline produced no draft", async () => {
    const appRoot = await makeAppRoot();
    const scratchRoot = await makeTempDir("vendo-corpus-ai-scratch-");
    const statics = await readRepoStaticContext(appRoot);

    const score = await evaluateDraft({
      draft: null,
      draftError: "staged extraction failed: every surface failed",
      statics,
      expected: null,
      scratchRoot,
    });

    expect(score.hardFailure).toBe(true);
    expect(score.score.value).toBe(0);
  });
});

describe("runAiRepoMatrix", () => {
  function stubHarness(behavior: (model: string | undefined, instructions: string) => string | Error): ExtractionHarness {
    return {
      id: "stub",
      availability: async () => "stub credential",
      run: async ({ env, instructions }) => {
        const result = behavior(env["VENDO_EXTRACTION_MODEL"], instructions);
        if (result instanceof Error) throw result;
        return result;
      },
    };
  }

  it("scores each model separately with clean per-model override state", async () => {
    const appRoot = await makeAppRoot();
    const expectationsRoot = await makeExpectationsRoot(true);
    const aiLogsDir = path.join(await makeTempDir("vendo-corpus-ai-logs-"), "ai");

    const result = await runAiRepoMatrix({
      repoName: "invoicer",
      appRoot,
      expectationsRoot,
      models: [DEFAULT_MODEL_LABEL, "claude-haiku-4-5"],
      aiLogsDir,
      env: {},
      // The default model answers every stage; the haiku column dies on every
      // pass, which the staged pipeline reports as a total failure.
      harness: stubHarness((model, instructions) =>
        (model === undefined ? stagedAnswers(instructions) : new Error("model exploded"))),
    });

    expect(result.labeled).toBe(true);
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({ model: DEFAULT_MODEL_LABEL, hardFailure: false, notes: [] });
    expect(result.models[0]?.score.value).toBe(1);
    expect(result.models[1]).toMatchObject({ model: "claude-haiku-4-5", hardFailure: true });
    expect(result.models[1]?.failure).toContain("staged extraction failed");
    // The same totals appear in both rows: comparable columns per repo.
    expect(result.models[1]?.score.total).toBe(result.models[0]?.score.total);
  });

  it("degrades with notes when one stage fails without flooring the run", async () => {
    const appRoot = await makeAppRoot();
    const expectationsRoot = await makeExpectationsRoot(true);
    const aiLogsDir = path.join(await makeTempDir("vendo-corpus-ai-logs-"), "ai");

    const result = await runAiRepoMatrix({
      repoName: "invoicer",
      appRoot,
      expectationsRoot,
      models: [DEFAULT_MODEL_LABEL],
      aiLogsDir,
      env: {},
      harness: stubHarness((_model, instructions) =>
        (instructions.includes("extraction surveyor") ? new Error("survey exploded") : stagedAnswers(instructions))),
    });

    expect(result.models[0]?.hardFailure).toBe(false);
    expect(result.models[0]?.notes.join("\n")).toContain("survey stage failed");
  });

  it("records a harness error as a floored, failed run instead of throwing", async () => {
    const appRoot = await makeAppRoot();
    const expectationsRoot = await makeExpectationsRoot(false);
    const aiLogsDir = path.join(await makeTempDir("vendo-corpus-ai-logs-"), "ai");

    const result = await runAiRepoMatrix({
      repoName: "invoicer",
      appRoot,
      expectationsRoot,
      models: [DEFAULT_MODEL_LABEL],
      aiLogsDir,
      env: {},
      harness: stubHarness(() => new Error("api key rejected")),
    });

    expect(result.labeled).toBe(false);
    expect(result.models[0]?.hardFailure).toBe(true);
    expect(result.models[0]?.failure).toContain("api key rejected");
    expect(result.models[0]?.score.value).toBe(0);
  });

  it("keeps per-model draft state isolated across runs on the same repo", async () => {
    const appRoot = await makeAppRoot();
    const expectationsRoot = await makeExpectationsRoot(true);
    const aiLogsDir = path.join(await makeTempDir("vendo-corpus-ai-logs-"), "ai");

    // Model A raises the delete correctly; model B never grades it. If model
    // B inherited model A's overrides, both would score identically.
    const lazyAnswers = (instructions: string): string => {
      if (instructions.includes("extraction surveyor")) return stagedAnswers(instructions);
      if (instructions.includes("cross-checker")) return fenced({ tools: [] });
      if (instructions.includes("drafting the product brief")) return fenced({ brief: goodBrief });
      return fenced({
        tools: goodDraftTools.map(({ name, description }) => ({ name, description })),
      });
    };
    const result = await runAiRepoMatrix({
      repoName: "invoicer",
      appRoot,
      expectationsRoot,
      models: ["model-a", "model-b"],
      aiLogsDir,
      env: {},
      harness: stubHarness((model, instructions) =>
        (model === "model-a" ? stagedAnswers(instructions) : lazyAnswers(instructions))),
    });

    expect(result.models[0]?.score.value).toBe(1);
    expect(result.models[1]?.score.value).toBeLessThan(1);
    expect(result.models[1]?.checks.find((check) => check.id === "ai.risk.accuracy")?.pass).toBe(false);
  });
});

describe("scoreboard", () => {
  it("renders one repo × model row per run in the corpus report style", () => {
    const repos: AiRepoResult[] = [
      {
        repo: "invoicer",
        labeled: true,
        models: [
          {
            model: "default",
            notes: ["surface \"billing\" skipped (rate limited) — its 4 tools keep extractor defaults"],
            score: { passed: 9, total: 10, value: 0.9 },
            dimensions: {
              draft: { passed: 1, total: 1, value: 1 },
              risk: { passed: 1, total: 2, value: 0.5 },
            },
            checks: [{ id: "ai.risk.accuracy", pass: false, detail: "1/2" }],
            hardFailure: false,
            artifactsDir: "/tmp/x",
          },
        ],
      },
      { repo: "broken", labeled: false, failure: "bootstrap failed", models: [] },
    ];
    const doc = buildAiScoreboard({ generatedAt: "2026-07-18T00:00:00.000Z", models: ["default"], repos });

    expect(doc.summary).toMatchObject({ repoCount: 2, runCount: 1, scoredRuns: 1, failedRuns: 1 });

    const markdown = renderAiScoreboardMarkdown(doc);
    expect(markdown).toContain("# AI extraction scoreboard");
    expect(markdown).toContain("| invoicer | default | 0.900 (9/10) |");
    expect(markdown).toContain("ai.risk.accuracy");
    expect(markdown).toContain("1 degradation note");
    expect(markdown).toContain("| broken | — | FAIL |");
  });

  it("slugs model ids into safe artifact directory names", () => {
    expect(modelDirName("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(modelDirName("anthropic/claude 5")).toBe("anthropic-claude-5");
    expect(modelDirName("///")).toBe("model");
  });
});
