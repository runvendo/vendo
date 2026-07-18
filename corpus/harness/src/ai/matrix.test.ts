import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtractionHarness } from "@vendoai/vendo/extract";
import {
  DEFAULT_MODEL_LABEL,
  buildAiScoreboard,
  evaluateAgentText,
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

const goodAgentText = [
  "Here is the draft:",
  "```json",
  JSON.stringify({
    brief: "Invoicer is a small invoicing product; users list their invoices and clean up old ones. The agent should help find invoices and delete stale drafts carefully.",
    tools: [
      { name: "host_api_invoices_get", description: "List the user's invoices with totals and status." },
      {
        name: "host_api_invoices_id_delete",
        description: "Permanently delete one invoice by id; cannot be undone.",
        risk: "destructive",
        critical: true,
      },
    ],
  }),
  "```",
].join("\n");

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

describe("evaluateAgentText", () => {
  it("runs a canned draft through the real guards and scores it", async () => {
    const appRoot = await makeAppRoot();
    const scratchRoot = await makeTempDir("vendo-corpus-ai-scratch-");
    const statics = await readRepoStaticContext(appRoot);

    const { score, draftJson } = await evaluateAgentText({
      text: goodAgentText,
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

    expect(draftJson).toBeDefined();
    expect(score.hardFailure).toBe(false);
    expect(score.score.value).toBe(1);
  });

  it("floors the score when the agent text has no parsable draft", async () => {
    const appRoot = await makeAppRoot();
    const scratchRoot = await makeTempDir("vendo-corpus-ai-scratch-");
    const statics = await readRepoStaticContext(appRoot);

    const { score, draftJson } = await evaluateAgentText({
      text: "I could not find any tools worth describing.",
      statics,
      expected: null,
      scratchRoot,
    });

    expect(draftJson).toBeUndefined();
    expect(score.hardFailure).toBe(true);
    expect(score.score.value).toBe(0);
  });
});

describe("runAiRepoMatrix", () => {
  function stubHarness(behavior: (model: string | undefined) => string | Error): ExtractionHarness {
    return {
      id: "stub",
      availability: async () => "stub credential",
      run: async ({ env }) => {
        const result = behavior(env["VENDO_EXTRACTION_MODEL"]);
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
      harness: stubHarness((model) => (model === undefined ? goodAgentText : "no draft here")),
    });

    expect(result.labeled).toBe(true);
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({ model: DEFAULT_MODEL_LABEL, hardFailure: false });
    expect(result.models[0]?.score.value).toBe(1);
    expect(result.models[1]).toMatchObject({ model: "claude-haiku-4-5", hardFailure: true });
    // The same totals appear in both rows: comparable columns per repo.
    expect(result.models[1]?.score.total).toBe(result.models[0]?.score.total);
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
    expect(markdown).toContain("| broken | — | FAIL |");
  });

  it("slugs model ids into safe artifact directory names", () => {
    expect(modelDirName("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(modelDirName("anthropic/claude 5")).toBe("anthropic-claude-5");
    expect(modelDirName("///")).toBe("model");
  });
});
