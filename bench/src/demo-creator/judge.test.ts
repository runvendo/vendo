import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { demoPaths } from "./demo-folder.js";
import {
  buildJudgePrompt,
  fidelityThreshold,
  formatScoresLine,
  judgeBackoffsMs,
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
  it("parses all five pinned dimensions, in rubric order, with their justifications", () => {
    const verdict = parseJudgeVerdict(verdictJson({ palette: 4, type: 6 }));
    expect(verdict.scores.map((score) => score.dimension)).toEqual([...judgeDimensions]);
    expect(verdict.scores.map((score) => score.score)).toEqual([9, 4, 6, 9, 9]);
    expect(verdict.scores[0]?.justification).toBe("logo looks right");
  });

  it("tolerates a markdown fence", () => {
    const verdict = parseJudgeVerdict("```json\n" + verdictJson({ palette: 8 }) + "\n```");
    expect(verdict.scores).toHaveLength(5);
    expect(verdict.scores.find((score) => score.dimension === "palette")?.score).toBe(8);
  });

  it("rejects a missing dimension or out-of-range score", () => {
    const missing = JSON.parse(verdictJson({})) as Record<string, unknown>;
    delete missing.copyTone;
    expect(() => parseJudgeVerdict(JSON.stringify(missing))).toThrow('"copyTone"');
    expect(() => parseJudgeVerdict(verdictJson({ logo: 11 }))).toThrow('"logo"');
  });

  // A justification of "   " passed the `!== ""` check and became a blank cell
  // that reads as "the judge had nothing to say", which is not what happened.
  it("treats a whitespace-only justification as absent", () => {
    const blank = JSON.parse(verdictJson({})) as Record<string, { justification: string }>;
    blank.logo = { ...blank.logo, justification: "  \n " } as { justification: string };
    expect(parseJudgeVerdict(JSON.stringify(blank)).scores[0]?.justification).toBe("(no justification given)");
  });

  // Duplicate keys are AMBIGUOUS: JSON.parse silently keeps the last, so a model
  // that emitted two different logo scores decided the recorded one by ordering.
  // Refusing costs the reroll; guessing costs a score nobody can trace.
  it("refuses duplicate dimension keys rather than taking the last one", () => {
    const doubled = '{"logo":{"score":9,"justification":"their mark"},"logo":{"score":2,"justification":"generic"},'
      + '"palette":{"score":9,"justification":"p"},"type":{"score":9,"justification":"t"},'
      + '"layout":{"score":9,"justification":"l"},"copyTone":{"score":9,"justification":"c"}}';
    expect(() => parseJudgeVerdict(doubled)).toThrow(/duplicate/i);
  });

  // Not silently dropped: an extra top-level key or an extra field inside a
  // dimension means the model answered a different question than the one asked,
  // and that belongs in the report rather than in nobody's hands.
  it("reports extra keys the rubric never asked for instead of ignoring them", () => {
    const extra = JSON.parse(verdictJson({})) as Record<string, unknown>;
    extra.overall = { score: 7, justification: "pretty good" };
    (extra.logo as Record<string, unknown>).confidence = "high";
    const verdict = parseJudgeVerdict(JSON.stringify(extra));
    expect(verdict.scores).toHaveLength(5);
    expect(verdict.extras.join("; ")).toContain("overall");
    expect(verdict.extras.join("; ")).toContain("logo.confidence");
  });

  it("has nothing to report when the model answered exactly the rubric", () => {
    expect(parseJudgeVerdict(verdictJson({})).extras).toEqual([]);
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

// The scores are a REPORT that never blocks a ship, so the judge's retry budget
// has to be small: the old 30s/60s/120s across two tiers, times the one reroll
// runJudge does on malformed JSON, was up to 16 vision calls and ~14 minutes
// inside a 20-minute end-to-end target.
describe("judge retry budget", () => {
  const tiers = 2;
  const rerolls = 2;

  it("cannot spend more than 8 vision calls on one judge stage", () => {
    const attemptsPerTier = judgeBackoffsMs.length + 1;
    expect(attemptsPerTier * tiers * rerolls).toBeLessThanOrEqual(8);
  });

  it("cannot spend more than 3 minutes waiting out an overload", () => {
    const waitPerTier = judgeBackoffsMs.reduce((total, wait) => total + wait, 0);
    expect(waitPerTier * tiers * rerolls).toBeLessThanOrEqual(4 * 60_000);
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
    expect(result.verdict?.scores).toHaveLength(5);
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

  // SHIP REGARDLESS covered the model call only. `readEvidenceImages` and the
  // report write sat OUTSIDE the try/catch, so a filesystem error — a RESEARCH
  // directory that is not there, an unwritable one — threw out of runJudge, the
  // pipeline awaited it before ship, and a finished demo never deployed.
  it("ships regardless when the RESEARCH directory cannot be read", async () => {
    const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-judge-"));
    await mkdir(demoPaths(demosRepo, "acme").root, { recursive: true });
    // No RESEARCH/ at all: readdir rejects with ENOENT.
    const io = stubIo(demosRepo, [verdictJson({})]);
    const result = await runJudge(args, io);
    expect(result.verdict).toBeUndefined();
    expect(result.scoresLine).toBe("judge=FAILED");
    expect(result.notes.join(" ")).toMatch(/ENOENT|could not read/i);
  });

  it("ships regardless when the fidelity report cannot be written", async () => {
    const demosRepo = await demoFixture({ evidence: true });
    const paths = demoPaths(demosRepo, "acme");
    // FIDELITY.md as a DIRECTORY: writeFile rejects with EISDIR.
    await mkdir(path.join(paths.researchDir, "FIDELITY.md"), { recursive: true });
    const io = stubIo(demosRepo, [verdictJson({ palette: 8, type: 7 })]);
    const result = await runJudge(args, io);
    // The scores still made it out — only the file did not.
    expect(result.scoresLine).toBe("logo=PASS palette=8 type=7 layout=9 copyTone=9");
    expect(result.notes.join(" ")).toMatch(/EISDIR|could not write/i);
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

  // The justification is MODEL TEXT going straight into a Markdown table cell. A
  // pipe splits the row into extra columns and a newline ends the row early, so
  // one chatty justification silently broke the whole score table.
  it("keeps the table intact when a justification carries a pipe or a newline", () => {
    const verdict: JudgeVerdict = parseJudgeVerdict(verdictJson({}));
    const messy: JudgeVerdict = {
      ...verdict,
      scores: verdict.scores.map((score) => score.dimension === "logo"
        ? { ...score, justification: "wordmark | header\nsecond line\r\nthird" }
        : score),
    };
    const report = renderFidelityReport({
      prospect: "Linear", verdict: messy, builtScreens: [], evidence: [], notes: [],
    });
    const rows = report.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| ---"));
    // Header + one row per dimension, and every row has the same column count —
    // counting only UNESCAPED pipes, which is what Markdown treats as a column
    // break (an escaped `\|` renders as a literal pipe inside the cell).
    expect(rows).toHaveLength(judgeDimensions.length + 1);
    for (const row of rows) expect(row.split(/(?<!\\)\|/)).toHaveLength(6);
    expect(report).toContain("wordmark \\| header second line third");
  });

  it("surfaces the keys the rubric never asked for as a note", () => {
    const extra = JSON.parse(verdictJson({})) as Record<string, unknown>;
    extra.overall = { score: 7 };
    const report = renderFidelityReport({
      prospect: "Linear",
      verdict: parseJudgeVerdict(JSON.stringify(extra)),
      builtScreens: [], evidence: [], notes: [],
    });
    expect(report).toContain("overall");
  });
});
