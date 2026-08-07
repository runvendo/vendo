import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VENDO_JUDGMENTS_FORMAT } from "@vendoai/actions";
import type { JudgmentPassOptions, JudgmentPassResult } from "@vendoai/vendo/extract";
import {
  DEFAULT_MODEL_LABEL,
  buildAiScoreboard,
  ensureAgentSdk,
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
  format: "vendo/tools@3",
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
        { name: "deleteInvoice", method: "DELETE", path: "/api/invoices/{id}", risk: "destructive", confirmEach: true },
      ],
    }));
  }
  return root;
}

/** The judgments a flawless pass would write for the fixture above. */
const perfectJudgments = {
  format: VENDO_JUDGMENTS_FORMAT,
  tools: {
    host_api_invoices_get: {
      binding: "GET /api/invoices",
      fields: { description: "List the current user's invoices with status and totals." },
      evidence: "const rows = await db.invoice.findMany({ where: { userId } })",
    },
    host_api_invoices_id_delete: {
      binding: "DELETE /api/invoices/{}",
      fields: {
        description: "Permanently delete one invoice by id; this cannot be undone.",
        risk: "destructive",
        confirmEach: true,
      },
      evidence: "await db.invoice.delete({ where: { id } })",
    },
  },
};

const judgedCounts = {
  judged: 2,
  hardened: 3,
  queued: 0,
  approved: 0,
  rejectedBySkeptic: 0,
  unexaminedRejected: 0,
  evidenceless: 0,
  advisoriesClamped: 0,
  inconsistentRisk: 0,
  schemasInferred: 0,
  schemasRejected: 0,
} as const;

/** A fake judgment pass: records the options it was handed, writes a canned
 * judgments file into the scratch `.vendo`, and never touches a model. */
function fakePass(
  body: (options: JudgmentPassOptions) => Promise<JudgmentPassResult>,
): { runPass: (options: JudgmentPassOptions) => Promise<JudgmentPassResult>; calls: JudgmentPassOptions[] } {
  const calls: JudgmentPassOptions[] = [];
  return {
    calls,
    runPass: async (options) => {
      calls.push(options);
      return await body(options);
    },
  };
}

function writingPass(file: unknown): (options: JudgmentPassOptions) => Promise<JudgmentPassResult> {
  return async (options) => {
    await mkdir(options.out, { recursive: true });
    await writeFile(path.join(options.out, "judgments.json"), JSON.stringify(file, null, 2));
    return { status: "judged", ...judgedCounts };
  };
}

async function runOneCell(overrides: {
  runPass: (options: JudgmentPassOptions) => Promise<JudgmentPassResult>;
  models?: readonly string[];
  labels?: boolean;
}): Promise<AiRepoResult> {
  const appRoot = await makeAppRoot();
  const expectationsRoot = await makeExpectationsRoot(overrides.labels ?? true);
  const aiLogsDir = path.join(await makeTempDir("vendo-corpus-ai-logs-"), "ai");
  return await runAiRepoMatrix({
    repoName: "invoicer",
    appRoot,
    expectationsRoot,
    models: overrides.models ?? [DEFAULT_MODEL_LABEL],
    aiLogsDir,
    env: {},
    harness: { id: "stub", availability: async () => "stub", run: async () => "{}" },
    runPass: overrides.runPass,
  });
}

describe("readRepoStaticContext", () => {
  it("maps tools.json into the scoring shape with binding identities", async () => {
    const appRoot = await makeAppRoot();
    const statics = await readRepoStaticContext(appRoot);

    expect(statics.appName).toBe("invoicer");
    expect(statics.forScoring).toHaveLength(2);
    expect(statics.forScoring[0]?.tool.name).toBe("host_api_invoices_get");
    expect(statics.forScoring[1]?.identity).toBe("DELETE\t/api/invoices/{id}");
  });

  it("throws a clear error when tools.json is absent", async () => {
    const appRoot = await makeTempDir("vendo-corpus-ai-empty-");
    await expect(readRepoStaticContext(appRoot)).rejects.toThrow(/tools\.json/);
  });
});

describe("runAiRepoMatrix", () => {
  it("scores the judgments the pass wrote into the scratch root", async () => {
    const result = await runOneCell({ runPass: writingPass(perfectJudgments) });

    expect(result.labeled).toBe(true);
    const cell = result.models[0]!;
    expect(cell.failure).toBeUndefined();
    expect(cell.hardFailure).toBe(false);
    expect(cell.score.value).toBe(1);
    expect(cell.counts).toMatchObject({ judged: 2, hardened: 3 });
  });

  it("drives the pass in full/review mode with an always-yes confirm against a scratch .vendo", async () => {
    const appRoot = await makeAppRoot();
    const expectationsRoot = await makeExpectationsRoot(true);
    const aiLogsDir = path.join(await makeTempDir("vendo-corpus-ai-logs-"), "ai");
    const pass = fakePass(writingPass(perfectJudgments));

    await runAiRepoMatrix({
      repoName: "invoicer",
      appRoot,
      expectationsRoot,
      models: [DEFAULT_MODEL_LABEL],
      aiLogsDir,
      env: {},
      harness: { id: "stub", availability: async () => "stub", run: async () => "{}" },
      runPass: pass.runPass,
    });

    expect(pass.calls).toHaveLength(1);
    const options = pass.calls[0]!;
    expect(options.mode).toBe("full");
    expect(options.loosenings).toBe("review");
    // Headless auto-approval: without this the review path DECLINES by default and
    // every downgrade the labels ask for would be dropped.
    await expect(options.confirm?.("apply?", false)).resolves.toBe(true);
    // The model reads the real repo; the judgments land in the per-cell scratch.
    expect(options.root).toBe(appRoot);
    expect(options.out).not.toBe(path.join(appRoot, ".vendo"));
    expect(options.out.startsWith(aiLogsDir)).toBe(true);
    // tools.json must be there or the pass would answer `skipped`.
    await expect(readFile(path.join(options.out, "tools.json"), "utf8")).resolves.toContain("host_api_invoices_get");
  });

  it("never writes into the repo's own .vendo", async () => {
    const appRoot = await makeAppRoot();
    const expectationsRoot = await makeExpectationsRoot(true);
    const aiLogsDir = path.join(await makeTempDir("vendo-corpus-ai-logs-"), "ai");

    await runAiRepoMatrix({
      repoName: "invoicer",
      appRoot,
      expectationsRoot,
      models: [DEFAULT_MODEL_LABEL, "claude-haiku-4-5"],
      aiLogsDir,
      env: {},
      harness: { id: "stub", availability: async () => "stub", run: async () => "{}" },
      runPass: writingPass(perfectJudgments),
    });

    await expect(readFile(path.join(appRoot, ".vendo", "judgments.json"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("floors a cell whose pass wrote no judgments, keeping the row comparable", async () => {
    const scored = await runOneCell({ runPass: writingPass(perfectJudgments) });
    const floored = await runOneCell({
      runPass: async () => ({ status: "structural-only", unjudged: 2 }),
    });

    const cell = floored.models[0]!;
    expect(cell.hardFailure).toBe(true);
    expect(cell.score.value).toBe(0);
    expect(cell.failure).toContain("structural-only");
    // Same denominator as a scored run: the column means the same thing in both rows.
    expect(cell.score.total).toBe(scored.models[0]!.score.total);
  });

  it("floors only the cell whose pass threw, not its sibling models", async () => {
    const result = await runOneCell({
      models: [DEFAULT_MODEL_LABEL, "claude-haiku-4-5"],
      runPass: async (options) => {
        if (options.env["VENDO_EXTRACTION_MODEL"] === "claude-haiku-4-5") throw new Error("model unreachable");
        return await writingPass(perfectJudgments)(options);
      },
    });

    expect(result.models).toHaveLength(2);
    expect(result.models[0]?.hardFailure).toBe(false);
    expect(result.models[1]?.hardFailure).toBe(true);
    expect(result.models[1]?.failure).toContain("model unreachable");
  });

  it("pins the model per cell and leaves the default label unpinned", async () => {
    const seen: Array<string | undefined> = [];
    await runOneCell({
      models: [DEFAULT_MODEL_LABEL, "claude-haiku-4-5"],
      runPass: async (options) => {
        seen.push(options.env["VENDO_EXTRACTION_MODEL"]);
        return await writingPass(perfectJudgments)(options);
      },
    });

    expect(seen).toEqual([undefined, "claude-haiku-4-5"]);
  });

  it("records the pass's own narrative and counts as cell artifacts", async () => {
    const result = await runOneCell({
      runPass: async (options) => {
        options.output.log("judgment (stub): 2 tools judged");
        options.output.error("warning: missed surface (not extracted yet): /api/webhooks");
        return await writingPass(perfectJudgments)(options);
      },
    });

    const cell = result.models[0]!;
    const log = await readFile(path.join(cell.artifactsDir, "pass.log"), "utf8");
    expect(log).toContain("2 tools judged");
    expect(log).toContain("missed surface");
  });

  it("turns queued and rejected proposals into degradation notes", async () => {
    const result = await runOneCell({
      runPass: async (options) => {
        await writingPass(perfectJudgments)(options);
        return {
          status: "judged",
          ...judgedCounts,
          queued: 2,
          rejectedBySkeptic: 1,
          evidenceless: 3,
        };
      },
    });

    const notes = result.models[0]!.notes.join(" | ");
    expect(notes).toContain("2 loosenings");
    expect(notes).toContain("1 rejected by the skeptic");
    expect(notes).toContain("3 proposals carried no evidence");
  });

  it("surfaces the pass's own warnings as degradation notes", async () => {
    // A judge batch that fails to parse takes every proposal in it down with it,
    // which depresses coverage and risk accuracy for a reason that has nothing to
    // do with model quality. The pass only reports it on its warning channel, so
    // the scoreboard has to read it from there or the table misleads.
    const result = await runOneCell({
      runPass: async (options) => {
        options.output.error("warning: judge batch 2/2 unusable (String must contain at most 300 character(s)) — its tools stay unjudged");
        options.output.log("judgment (explicit engine): 2 tools judged");
        return await writingPass(perfectJudgments)(options);
      },
    });

    const notes = result.models[0]!.notes.join(" | ");
    expect(notes).toContain("judge batch 2/2 unusable");
    // Plain narrative lines are not degradation notes.
    expect(notes).not.toContain("2 tools judged");
  });

  it("trims a warning's payload so one row cannot wreck the table", async () => {
    // The real batch-parse warning embeds the whole zod issue array — ~300 chars
    // of JSON with newlines. It belongs in the Notes cell as a FACT, not as a
    // wall of punctuation.
    const zodNoise = `([\n  {\n    "code": "too_big",\n    "maximum": 300,\n    "path": [\n      "missedSurfaces",\n      0\n    ]\n  }\n])`;
    const result = await runOneCell({
      runPass: async (options) => {
        options.output.error(`warning: judge batch 2/2 unusable ${zodNoise} — its tools stay unjudged`);
        return await writingPass(perfectJudgments)(options);
      },
    });

    const note = result.models[0]!.notes.find((line) => line.includes("judge batch 2/2"))!;
    expect(note).toContain("judge batch 2/2 unusable");
    expect(note).not.toContain("\n");
    expect(note.length).toBeLessThanOrEqual(160);
  });

  it("floors a cell when the judgments file is malformed rather than crashing the repo row", async () => {
    const result = await runOneCell({
      runPass: async (options) => {
        await mkdir(options.out, { recursive: true });
        await writeFile(path.join(options.out, "judgments.json"), "{ not json");
        return { status: "judged", ...judgedCounts };
      },
    });

    const cell = result.models[0]!;
    expect(cell.hardFailure).toBe(true);
    expect(cell.failure).toMatch(/judgments\.json/);
  });
});

describe("ensureAgentSdk", () => {
  async function fakeInstall(dir: string): Promise<void> {
    const packageDir = path.join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, "package.json"), JSON.stringify({
      name: "@anthropic-ai/claude-agent-sdk",
      version: "0.0.0-fake",
      main: "index.cjs",
    }));
    await writeFile(path.join(packageDir, "index.cjs"), "module.exports = { query() {} };\n");
  }

  it("installs the pinned SDK into the cache once and is a no-op after", async () => {
    const sdkDir = path.join(await makeTempDir("vendo-corpus-ai-sdk-"), ".agent-sdk");
    const installs: string[] = [];

    await ensureAgentSdk(sdkDir, async (dir) => {
      installs.push(dir);
      await fakeInstall(dir);
    });
    await ensureAgentSdk(sdkDir, async (dir) => {
      installs.push(dir);
    });

    expect(installs).toEqual([sdkDir]);
  });

  it("fails with a clear provisioning message instead of hanging", async () => {
    const sdkDir = path.join(await makeTempDir("vendo-corpus-ai-sdk-"), ".agent-sdk");
    await expect(ensureAgentSdk(sdkDir, async () => {
      throw new Error("npm install exited 1: network down");
    })).rejects.toThrow(/Could not provision @anthropic-ai\/claude-agent-sdk.*network down/s);
  });

  it("fails loudly when the install completes but the SDK still does not resolve", async () => {
    const sdkDir = path.join(await makeTempDir("vendo-corpus-ai-sdk-"), ".agent-sdk");
    await expect(ensureAgentSdk(sdkDir, async () => {})).rejects.toThrow(/still does not resolve/);
  });
});

describe("scoreboard", () => {
  it("renders one repo × model row per run with the judgment columns", () => {
    const repos: AiRepoResult[] = [
      {
        repo: "invoicer",
        labeled: true,
        models: [
          {
            model: "default",
            notes: ["4 loosenings queued rather than approved"],
            score: { passed: 9, total: 10, value: 0.9 },
            dimensions: {
              pass: { passed: 1, total: 1, value: 1 },
              risk: { passed: 1, total: 2, value: 0.5 },
              evidence: { passed: 1, total: 1, value: 1 },
            },
            checks: [{ id: "ai.risk.accuracy", pass: false, detail: "1/2" }],
            hardFailure: false,
            artifactsDir: "/tmp/x",
          },
        ],
      },
      { repo: "broken", labeled: false, failure: "bootstrap failed", models: [] },
    ];
    const doc = buildAiScoreboard({ generatedAt: "2026-07-28T00:00:00.000Z", models: ["default"], repos });

    expect(doc.summary).toMatchObject({ repoCount: 2, runCount: 1, scoredRuns: 1, failedRuns: 1 });

    const markdown = renderAiScoreboardMarkdown(doc);
    expect(markdown).toContain("# Judgment channel scoreboard");
    expect(markdown).toContain("Risk accuracy");
    expect(markdown).toContain("Evidence");
    // Dimensions render as percentages; fractional point sums like `0.333333/1`
    // are unreadable in a scanned table.
    expect(markdown).toContain("| invoicer | default | 0.900 (9/10) | 50% | — | — | 100% |");
    expect(markdown).toContain("| broken | — | FAIL |");
    // The lossy percentages are backed by each failing check's own counts.
    expect(markdown).toContain("## Failing checks");
    expect(markdown).toContain("### invoicer × default");
    expect(markdown).toContain("`ai.risk.accuracy` — 1/2");
  });

  it("slugs model ids into safe artifact directory names", () => {
    expect(modelDirName("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(modelDirName("anthropic/claude 5")).toBe("anthropic-claude-5");
    expect(modelDirName("///")).toBe("model");
  });
});
