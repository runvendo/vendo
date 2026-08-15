/**
 * The run folder is a seam. `run.ts` writes one directory per contender per case
 * and names the files inside it; `report.ts` spells that nesting and those
 * filenames again, on its own, to read them back.
 *
 * Nothing crossed that line until now. `report.test.ts` builds its results in
 * memory over an empty temp dir, so every column it renders takes the "nothing
 * rendered" branch and the thumbnail block never runs at all — the writer could
 * rename `page.html` tomorrow and the whole suite would stay green over a
 * preview whose frames are all blank.
 *
 * So this drives BOTH real sides over one real directory: the real writer puts a
 * case on disk, the real reporter renders that same directory, and the page's own
 * frame and thumbnail are checked against the bytes that were written. The only
 * stub is the contender — the artifact, the page and the shot are handed over the
 * way a driver hands them over. The filesystem and the reader are real, and this
 * test names no path segment and no filename itself, so it can only pass while
 * the two halves still agree.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FloorResult } from "../src/floor.js";
import { AUDITOR_CONTRACT } from "../src/audit.js";
import { JudgeContract, type JudgeResult } from "../src/judge.js";
import type { Shot } from "../src/render.js";
import { writePreview } from "../src/report.js";
import { writeCase, type CaseResult, type RunOutcome } from "../src/run.js";
import { TriageContract } from "../src/triage.js";

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>genbench</title></head>
<body><p>3 pending transfers</p></body></html>`;

/** A real 1x1 PNG. The report inlines these bytes, so they have to survive the
 *  round trip through disk and base64 exactly. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** The contender boundary, and the only thing stubbed here: what a driver hands
 *  back, and what the browser shot of it. */
const OUTCOME: RunOutcome = { artifact: `<screen id="transfers"/>`, blocking: [], snapshots: [], settledMs: 2_000 };

const SHOT: Shot = { png: PNG, visibleText: "3 pending transfers", renders: true, consoleErrors: [] };

const PASSING: FloorResult = {
  delivered: true,
  renders: true,
  valid: true,
  blocking: [],
  honestData: { pass: true, offenders: [], examined: 1 },
  wiredActions: { pass: true, pressed: 1, bindings: [] },
  pass: true,
};

const JUDGED: JudgeResult = {
  lines: [
    { line: "shows every pending transfer the tool returned", source: "case", verdict: "pass", note: "three rows are listed" },
  ],
  degraded: false,
};

const RESULT: CaseResult = {
  run: "run-1",
  contender: "vendo-sonnet",
  model: "claude-sonnet-5",
  case: "pending-transfers",
  prompt: "Show my pending transfers.",
  lane: "screen",
  shape: "table",
  floor: PASSING,
  timing: { firstRenderMs: 1_000, settledMs: 2_000 },
  cost: { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 }, usd: 0.01 },
  islands: 0,
  clientOnly: 0,
  trace: [],
  consoleErrors: [],
  world: "hash",
  caseHash: "case-hash",
  judged: JUDGED,
  judgeContract: JudgeContract,
  triageContract: TriageContract,
  auditorContract: AUDITOR_CONTRACT,
};

describe("the run folder", () => {
  it("hands the preview a frame and a thumbnail that are the files the run actually wrote", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "genbench-run-folder-"));

    await writeCase(runDir, { outcome: OUTCOME, html: PAGE, shot: SHOT, result: RESULT });
    const html = await readFile(
      await writePreview({ runDir, runId: RESULT.run, results: [RESULT], worlds: {} }),
      "utf8",
    );

    // The live frame is a relative link into the run folder beside the preview,
    // so the page is only as good as that link resolving on disk.
    const frame = /<iframe[^>]*\ssrc="([^"]+)"/.exec(html)?.[1];
    expect(frame).toBeDefined();
    expect(await readFile(join(runDir, frame!), "utf8")).toBe(PAGE);

    // The judge's thumbnail is inlined, so the bytes on the page ARE the bytes
    // the writer put on disk — and it is only on the page at all while the
    // reporter can still find the file the writer named.
    const thumbnail = /<img[^>]*\ssrc="data:image\/png;base64,([^"]+)"/.exec(html)?.[1];
    expect(thumbnail).toBeDefined();
    expect(Buffer.from(thumbnail!, "base64")).toEqual(PNG);
  });
});
