import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ResearchReport } from "./research.js";
import type { RewritePlan } from "./rewrite.js";
import {
  buildFixPrompt,
  buildJudgePrompt,
  fidelityThreshold,
  judgeDimensions,
  parseJudgeVerdict,
  renderFidelityReport,
  runJudgeLoop,
  selectEvidenceImages,
  type JudgeVerdict,
} from "./judge.js";

function verdictJson(scores: Partial<Record<(typeof judgeDimensions)[number], number>>): string {
  const entries = judgeDimensions.map((dimension) => [
    dimension,
    { score: scores[dimension] ?? 9, justification: `${dimension} looks right` },
  ]);
  return JSON.stringify(Object.fromEntries(entries));
}

describe("parseJudgeVerdict", () => {
  it("parses all five pinned dimensions and computes failing ones", () => {
    const verdict = parseJudgeVerdict(verdictJson({ palette: 4, type: 6 }));
    expect(verdict.scores).toHaveLength(5);
    expect(verdict.failing).toEqual(["palette", "type"]);
    expect(verdict.pass).toBe(false);
  });

  it("passes only when every dimension reaches the threshold", () => {
    const verdict = parseJudgeVerdict(verdictJson({ palette: fidelityThreshold }));
    expect(verdict.pass).toBe(true);
    expect(verdict.failing).toEqual([]);
  });

  it("tolerates a markdown fence", () => {
    expect(parseJudgeVerdict("```json\n" + verdictJson({}) + "\n```").pass).toBe(true);
  });

  it("rejects a missing dimension or out-of-range score", () => {
    const missing = JSON.parse(verdictJson({})) as Record<string, unknown>;
    delete missing.copyTone;
    expect(() => parseJudgeVerdict(JSON.stringify(missing))).toThrow('"copyTone"');
    expect(() => parseJudgeVerdict(verdictJson({ logo: 11 }))).toThrow('"logo"');
  });
});

describe("buildJudgePrompt", () => {
  it("pins the five dimensions and the harsh-judging framing", () => {
    const prompt = buildJudgePrompt({ prospect: "Linear" });
    for (const dimension of judgeDimensions) expect(prompt).toContain(`"${dimension}"`);
    expect(prompt).toContain("harsh");
    expect(prompt).toContain("EVIDENCE");
    expect(prompt).toContain("BUILT");
  });
});

describe("buildFixPrompt", () => {
  it("names the dimension, the score, and the judge's evidence", () => {
    const prompt = buildFixPrompt({
      prospect: "Linear",
      dimension: "palette",
      score: { dimension: "palette", score: 4, justification: "accent drifts toward teal" },
      round: 1,
    });
    expect(prompt).toContain("palette");
    expect(prompt).toContain("4/10");
    expect(prompt).toContain("accent drifts toward teal");
    expect(prompt).toContain("NEVER touch the fenced files");
  });
});

function reportFixture(withOperator: boolean): ResearchReport {
  return {
    capturedAt: "2026-07-26T00:00:00.000Z",
    urls: ["https://linear.app"],
    operatorScreenshots: withOperator
      ? [{ file: "operator-1-board.png", provenance: "operator-provided", source: "/tmp/board.png" }]
      : [],
    pages: [{
      url: "https://linear.app",
      title: "Linear",
      themeColor: null,
      favicon: null,
      botChallenge: false,
      screenshots: { viewport: "page-1-viewport.png", fullPage: "page-1-full.png" },
      samples: [],
      colorRoles: [],
      fontFaces: [],
      webfontLinks: [],
      assets: [],
    }],
    palette: { colors: [], fontFamilies: [] },
    fonts: { families: [], faceSrcs: [], webfontLinks: [] },
  };
}

describe("selectEvidenceImages", () => {
  it("labels operator screenshots and the live capture, operator first, both classes present", async () => {
    const researchDir = await mkdtemp(path.join(tmpdir(), "vendo-judge-evidence-"));
    await writeFile(path.join(researchDir, "operator-1-board.png"), "png");
    await writeFile(path.join(researchDir, "page-1-viewport.png"), "png");
    const { images, missing } = selectEvidenceImages(reportFixture(true), researchDir);
    expect(images).toHaveLength(2);
    expect(images[0]?.label).toContain("operator");
    expect(images[1]?.label).toContain("live-site");
    expect(missing).toEqual([]);
  });

  it("reports each absent evidence class as missing (criterion 36 requires BOTH)", async () => {
    const researchDir = await mkdtemp(path.join(tmpdir(), "vendo-judge-evidence-"));
    expect(selectEvidenceImages(reportFixture(true), researchDir).missing)
      .toEqual(["operator-screenshots", "live-site-capture"]);
    await writeFile(path.join(researchDir, "operator-1-board.png"), "png");
    expect(selectEvidenceImages(reportFixture(true), researchDir).missing).toEqual(["live-site-capture"]);
    await writeFile(path.join(researchDir, "page-1-viewport.png"), "png");
    expect(selectEvidenceImages(reportFixture(false), researchDir).missing).toEqual(["operator-screenshots"]);
  });
});

const plan: RewritePlan = {
  entity: { name: "Issue", stem: "issues", action: "closeIssue", fields: ["id"], sampleRecordNames: ["Fix onboarding"] },
  screens: [
    { slug: "board", route: "/", title: "Board", purpose: "reference clone" },
    { slug: "backlog", route: "/backlog", title: "Backlog", purpose: "list" },
  ],
  nav: ["Inbox"],
  copyTone: "terse",
};

describe("runJudgeLoop", () => {
  async function makeFixture(): Promise<{ repoRoot: string; appDir: string }> {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "vendo-judge-loop-"));
    const appDir = path.join(repoRoot, "apps", "demo-linear");
    const researchDir = path.join(appDir, "RESEARCH");
    await mkdir(researchDir, { recursive: true });
    await writeFile(path.join(researchDir, "research.json"), JSON.stringify(reportFixture(true)));
    await writeFile(path.join(researchDir, "operator-1-board.png"), "png");
    await writeFile(path.join(researchDir, "page-1-viewport.png"), "png");
    return { repoRoot, appDir };
  }

  const baseArgs = { prospect: "Linear", packageName: "demo-linear", plan, port: 3150 };

  function stubIo(appDir: string, repoRoot: string, verdicts: string[]) {
    let call = 0;
    const fixAgents: string[] = [];
    const io = {
      appDir,
      repoRoot,
      judgeModel: vi.fn(async () => verdicts[Math.min(call++, verdicts.length - 1)] as string),
      captureScreens: vi.fn(async (options: { outDir: string; routes: string[] }) => {
        await mkdir(options.outDir, { recursive: true });
        return options.routes.map((route) => path.join(options.outDir, `built-${route === "/" ? "home" : route.slice(1)}.png`));
      }),
      runAgent: vi.fn(async (job: { name: string }) => {
        fixAgents.push(job.name);
        return { name: job.name, code: 0, output: "fixed", costUsd: 1, timedOut: false };
      }),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      write: () => {},
      env: {},
    };
    return { io, fixAgents };
  }

  it("ships on a first-round pass without any fix agents", async () => {
    const { repoRoot, appDir } = await makeFixture();
    const { io, fixAgents } = stubIo(appDir, repoRoot, [verdictJson({})]);
    const result = await runJudgeLoop(baseArgs, io);
    expect(result.parked).toBe(false);
    expect(result.rounds).toHaveLength(1);
    expect(fixAgents).toEqual([]);
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("**SHIP**");
  });

  it("runs one targeted fix per failing dimension, rebuilds, and re-judges to a pass", async () => {
    const { repoRoot, appDir } = await makeFixture();
    const { io, fixAgents } = stubIo(appDir, repoRoot, [verdictJson({ palette: 4, logo: 5 }), verdictJson({})]);
    const result = await runJudgeLoop(baseArgs, io);
    expect(result.parked).toBe(false);
    expect(result.rounds).toHaveLength(2);
    expect(fixAgents).toEqual(["fix-logo-1", "fix-palette-1"].sort((a, b) =>
      judgeDimensions.indexOf(a.split("-")[1] as never) - judgeDimensions.indexOf(b.split("-")[1] as never)));
    expect(io.exec).toHaveBeenCalledWith(["pnpm", "exec", "turbo", "run", "build", "--filter=demo-linear"], { cwd: repoRoot });
  });

  it("parks after the round cap with a report naming every failing dimension — never ships", async () => {
    const { repoRoot, appDir } = await makeFixture();
    const { io } = stubIo(appDir, repoRoot, [verdictJson({ palette: 4 })]);
    const result = await runJudgeLoop(baseArgs, io);
    expect(result.parked).toBe(true);
    expect(result.rounds).toHaveLength(3); // initial + 2 fix rounds, all failing
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("PARKED — DO NOT SHIP");
    expect(report).toContain("palette");
    expect(report).toContain("scored against 2 evidence image(s)".replace("scored", "Scored"));
  });

  it("rerolls once when the judge returns malformed JSON", async () => {
    const { repoRoot, appDir } = await makeFixture();
    const { io } = stubIo(appDir, repoRoot, ['{"logo"::"broken"', verdictJson({})]);
    const result = await runJudgeLoop(baseArgs, io);
    expect(result.parked).toBe(false);
    expect(io.judgeModel).toHaveBeenCalledTimes(2);
  });

  it("PARKS (never ships) when the operator-screenshot class is missing — criterion 36 needs both", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "vendo-judge-noop-"));
    const appDir = path.join(repoRoot, "apps", "demo-linear");
    await mkdir(path.join(appDir, "RESEARCH"), { recursive: true });
    await writeFile(path.join(appDir, "RESEARCH", "research.json"), JSON.stringify(reportFixture(false)));
    await writeFile(path.join(appDir, "RESEARCH", "page-1-viewport.png"), "png");
    const { io } = stubIo(appDir, repoRoot, [verdictJson({})]);
    const result = await runJudgeLoop(baseArgs, io);
    expect(result.parked).toBe(true);
    expect(io.judgeModel).not.toHaveBeenCalled();
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("PARKED — DO NOT SHIP");
    expect(report).toContain("operator-screenshots");
  });

  it("PARKS when the live-site-capture class is missing", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "vendo-judge-nolive-"));
    const appDir = path.join(repoRoot, "apps", "demo-linear");
    await mkdir(path.join(appDir, "RESEARCH"), { recursive: true });
    await writeFile(path.join(appDir, "RESEARCH", "research.json"), JSON.stringify(reportFixture(true)));
    await writeFile(path.join(appDir, "RESEARCH", "operator-1-board.png"), "png");
    const { io } = stubIo(appDir, repoRoot, [verdictJson({})]);
    const result = await runJudgeLoop(baseArgs, io);
    expect(result.parked).toBe(true);
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("live-site-capture");
  });

  it("records verdicts for every round in the fidelity report", async () => {
    const { repoRoot, appDir } = await makeFixture();
    const { io } = stubIo(appDir, repoRoot, [verdictJson({ layout: 5 }), verdictJson({})]);
    const result = await runJudgeLoop(baseArgs, io);
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("Round 1 — FAIL (layout)");
    expect(report).toContain("Round 2 — PASS");
  });
});

describe("renderFidelityReport", () => {
  it("marks sub-threshold rows as FAIL", () => {
    const verdict: JudgeVerdict = parseJudgeVerdict(verdictJson({ type: 3 }));
    const report = renderFidelityReport({
      prospect: "Linear",
      rounds: [{ round: 1, verdict, builtScreens: ["/x/built-home.png"] }],
      parked: true,
      evidence: [{ label: "EVIDENCE operator screenshot", path: "/x/op.png" }],
    });
    expect(report).toContain("| type | 3 | FAIL |");
    expect(report).toContain("PARKED");
  });
});
