import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildScorecard,
  renderScorecardMarkdown,
  scorecardExitCode,
  writeScorecardArtifacts,
} from "./scorecard.js";
import { createRunContext } from "./run-context.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vendo-corpus-scorecard-"));
  tempRoots.push(root);
  return root;
}

describe("buildScorecard", () => {
  it("aggregates per-repo, per-layer checks into JSON-ready summary data", () => {
    const scorecard = buildScorecard({
      generatedAt: "2026-07-05T12:00:00.000Z",
      strict: true,
      repos: [
        {
          repo: "umami",
          layers: [
            {
              layer: 1,
              name: "structural",
              checks: [
                { id: "init.exit", pass: true, detail: "ok" },
                { id: "host.build", pass: false, detail: "build failed" },
              ],
              logPaths: ["/tmp/corpus/.repos/.logs/umami/init.log"],
            },
          ],
        },
        {
          repo: "invoify",
          layers: [
            {
              layer: 1,
              name: "structural",
              checks: [{ id: "init.exit", pass: true, detail: "ok" }],
              logPaths: [],
            },
          ],
        },
      ],
    });

    expect(scorecard.summary).toEqual({
      repoCount: 2,
      layerCount: 2,
      passedLayers: 1,
      failedLayers: 1,
      hardFailureCount: 1,
    });
    expect(scorecard.repos[0]?.layers[0]).toMatchObject({
      layer: 1,
      status: "fail",
      score: { passed: 1, total: 2, value: 0.5 },
      hardFailure: true,
    });
    expect(scorecardExitCode(scorecard)).toBe(1);
    expect(scorecardExitCode({ ...scorecard, strict: false })).toBe(0);
  });
});

describe("renderScorecardMarkdown", () => {
  it("renders a readable repo x layer table with links to logs", () => {
    const scorecard = buildScorecard({
      generatedAt: "2026-07-05T12:00:00.000Z",
      strict: false,
      repos: [
        {
          repo: "umami",
          layers: [
            {
              layer: 1,
              name: "structural",
              status: "pass",
              score: { passed: 7, total: 7, value: 1 },
              logPaths: ["/work/corpus/.repos/.logs/umami/init.log"],
            },
          ],
        },
      ],
    });

    expect(renderScorecardMarkdown(scorecard, { linkBaseDir: "/work/corpus" })).toContain(
      "| umami | Layer 1 structural | PASS | 7/7 | [.repos/.logs/umami/init.log](.repos/.logs/umami/init.log) |",
    );
  });
});

describe("writeScorecardArtifacts", () => {
  it("writes the aggregate scorecard under .repos/.logs and a per-repo run copy", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    await mkdir(context.repoDir("umami"), { recursive: true });
    const scorecard = buildScorecard({
      generatedAt: "2026-07-05T12:00:00.000Z",
      strict: false,
      repos: [
        {
          repo: "umami",
          layers: [
            {
              layer: 1,
              name: "structural",
              status: "pass",
              logPaths: [],
            },
          ],
        },
      ],
    });

    const artifacts = await writeScorecardArtifacts(scorecard, { context });

    expect(artifacts.json).toBe(path.join(context.reposDir, ".logs", "scorecard.json"));
    await expect(readFile(artifacts.json, "utf8").then(JSON.parse)).resolves.toMatchObject({
      generatedAt: "2026-07-05T12:00:00.000Z",
      summary: { repoCount: 1, failedLayers: 0 },
    });
    await expect(readFile(artifacts.markdown, "utf8")).resolves.toContain("| umami | Layer 1 structural | PASS |");
    await expect(readFile(path.join(context.repoDir("umami"), "run", "scorecard.json"), "utf8")).resolves.toContain("\"repo\": \"umami\"");
  });
});
