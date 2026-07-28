import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { demoPaths } from "./demo-folder.js";
import {
  buildJudgePrompt,
  fidelityThreshold,
  formatScoresLine,
  judgeDimensions,
  parseJudgeVerdict,
  renderFidelityReport,
  runJudge,
  type CaptureScreensOptions,
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

describe("formatScoresLine", () => {
  it("prints logo as PASS/FAIL and every other dimension as its score", () => {
    const verdict = parseJudgeVerdict(verdictJson({ logo: 9, palette: 8, type: 7, layout: 9, copyTone: 8 }));
    expect(formatScoresLine(verdict)).toBe("logo=PASS palette=8 type=7 layout=9 copyTone=8");
  });

  it("PASSes logo exactly at the threshold and FAILs one below it", () => {
    expect(formatScoresLine(parseJudgeVerdict(verdictJson({ logo: fidelityThreshold })))).toContain("logo=PASS");
    expect(formatScoresLine(parseJudgeVerdict(verdictJson({ logo: fidelityThreshold - 1 })))).toContain("logo=FAIL");
  });
});

describe("runJudge", () => {
  async function demoFixture(options: { evidence: boolean }): Promise<string> {
    const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-judge-"));
    const paths = demoPaths(demosRepo, "acme");
    await mkdir(paths.researchDir, { recursive: true });
    if (options.evidence) {
      await writeFile(path.join(paths.researchDir, "operator-1-dashboard.png"), "png");
      await writeFile(path.join(paths.researchDir, "operator-2-invoices.png"), "png");
    }
    return demosRepo;
  }

  const args = { slug: "acme", prospect: "Acme", baseUrl: "http://127.0.0.1:3400" };

  function stubIo(demosRepo: string, replies: (string | Error)[]) {
    let call = 0;
    return {
      demosRepo,
      judgeModel: vi.fn(async () => {
        const reply = replies[Math.min(call++, replies.length - 1)];
        if (reply instanceof Error) throw reply;
        return reply as string;
      }),
      captureScreens: vi.fn(async (options: CaptureScreensOptions) => {
        await mkdir(options.outDir, { recursive: true });
        return options.routes.map((route) => path.join(options.outDir, `built-${route.replaceAll("/", "-")}.png`));
      }),
      write: () => {},
      env: {},
    };
  }

  it("screenshots the running host's demo routes and records the scores", async () => {
    const demosRepo = await demoFixture({ evidence: true });
    const io = stubIo(demosRepo, [verdictJson({ palette: 8, type: 7 })]);
    const result = await runJudge(args, io);
    expect(io.captureScreens).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "http://127.0.0.1:3400",
      routes: ["/acme", "/acme/vendo"],
    }));
    expect(result.builtScreens).toHaveLength(2);
    expect(result.scoresLine).toBe("logo=PASS palette=8 type=7 layout=9 copyTone=9");
    expect(result.notes).toEqual([]);
    const report = await readFile(result.reportPath, "utf8");
    expect(result.reportPath).toBe(path.join(demoPaths(demosRepo, "acme").researchDir, "FIDELITY.md"));
    expect(report).toContain("| palette | 8 | pass |");
    expect(report).toContain("2 evidence image(s)");
  });

  it("passes both the evidence and the built screens to the model, evidence first", async () => {
    const demosRepo = await demoFixture({ evidence: true });
    const io = stubIo(demosRepo, [verdictJson({})]);
    await runJudge(args, io);
    const images = io.judgeModel.mock.calls[0]?.[1] as { label: string }[];
    expect(images.map((image) => image.label)).toEqual([
      expect.stringContaining("EVIDENCE"),
      expect.stringContaining("EVIDENCE"),
      "BUILT screen /acme",
      "BUILT screen /acme/vendo",
    ]);
  });

  it("rerolls once when the judge returns malformed JSON", async () => {
    const demosRepo = await demoFixture({ evidence: true });
    const io = stubIo(demosRepo, ['{"logo"::"broken"', verdictJson({})]);
    const result = await runJudge(args, io);
    expect(io.judgeModel).toHaveBeenCalledTimes(2);
    expect(result.verdict?.pass).toBe(true);
  });

  it("ships regardless when the judge model fails outright, recording it as a note", async () => {
    const demosRepo = await demoFixture({ evidence: true });
    const io = stubIo(demosRepo, [new Error("Overloaded")]);
    const result = await runJudge(args, io);
    expect(result.verdict).toBeUndefined();
    expect(result.scoresLine).toBe("judge=FAILED");
    expect(result.notes.join(" ")).toContain("Overloaded");
    expect(await readFile(result.reportPath, "utf8")).toContain("Overloaded");
  });

  it("records missing evidence as a NOTE and never parks", async () => {
    const demosRepo = await demoFixture({ evidence: false });
    const io = stubIo(demosRepo, [verdictJson({})]);
    const result = await runJudge(args, io);
    expect(io.judgeModel).not.toHaveBeenCalled();
    expect(result.verdict).toBeUndefined();
    expect(result.notes.join(" ")).toContain("RESEARCH/");
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("NOTE");
    expect(report).not.toContain("PARK");
  });
});

describe("renderFidelityReport", () => {
  it("marks sub-threshold rows as FAIL and lists the notes", () => {
    const verdict: JudgeVerdict = parseJudgeVerdict(verdictJson({ type: 3 }));
    const report = renderFidelityReport({
      prospect: "Linear",
      verdict,
      builtScreens: ["/x/built-acme.png"],
      evidence: [{ label: "EVIDENCE operator screenshot", path: "/x/op.png" }],
      notes: ["logo evidence was missing"],
    });
    expect(report).toContain("| type | 3 | FAIL |");
    expect(report).toContain("NOTE: logo evidence was missing");
  });
});
