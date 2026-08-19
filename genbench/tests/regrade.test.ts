/**
 * A rubric change makes every screen already recorded incomparable, and building
 * those screens again is hours and hundreds of dollars for work that is already
 * on disk. `regrade` scores the saved folder instead — so what has to be true is
 * that a saved run really is enough evidence, and that what comes back is a whole
 * run folder a person can open.
 *
 * Both real halves over one real directory: the run's OWN writer puts a case on
 * disk, `regrade` reads that same directory and writes a new one beside it, and
 * these tests read THAT one back. The only doubles are the judge's model — the
 * real grader is a paid third party — and the contender, which never runs at all.
 *
 * One test paints a page in a real browser: a run recorded before `writeCase`
 * saved the settled DOM has to have it recovered, and that is the only path here
 * a browser is on.
 */
import { MockLanguageModelV3 } from "ai/test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { FloorResult } from "../src/floor.js";
import { JudgeContract, type JudgeResult } from "../src/judge.js";
import type { RunSummary } from "../src/report.js";
import { authoredPage } from "../src/render.js";
import { regrade, writeCase, type CaseResult } from "../src/run.js";
import { caseHash, loadCases, loadWorld, type Case, type World } from "../src/world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let world: World;
let testCase: Case;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
  testCase = (await loadCases(join(root, "worlds", "maple", "cases.json"))).find(
    (entry) => entry.id === "pending-transfers",
  )!;
});

/** A real 1x1 PNG: the picture the judge is shown is the one on disk, so it has
 *  to survive being linked into another folder byte for byte. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** The wide table's own picture, distinct from the shot above: the judge is shown
 *  both, and a re-score that sent the same bytes twice would read as passing. */
const TABLE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

/** The document the contender saved — a page with one live control on it, so the
 *  saved trace below is a trace this page could really have produced. */
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head>
<body><p>2 pending transfers</p>
<button onclick="window.vendo.callTool('cancel_transfer', { id: 'tr_1' })">Cancel</button></body></html>`;

/** The DOM the run recorded, which is NOT what painting the page again would
 *  produce — so a re-score that reads the saved one can be told from one that
 *  went back to the browser. */
const DOM = `<html lang="en"><head><title>t</title></head><body><p>the DOM the run recorded</p></body></html>`;

/** The floor as an older harness left it: a `wiredActions` verdict today's code
 *  reaches differently off the same trace, so re-scoring has something to move. */
const STALE: FloorResult = {
  delivered: true,
  renders: true,
  valid: true,
  blocking: [],
  wiredActions: { pass: false, pressed: 0, bindings: [] },
  pass: false,
};

/** The contract this screen was really graded under, and the whole reason to
 *  grade it again. The type pins the version at today's number; a saved run's is
 *  whatever it was on the day, which no type can say. */
const GRADED_UNDER_V3 = { ...JudgeContract, rubricVersion: 3 } as unknown as typeof JudgeContract;

const JUDGED_UNDER_V3: JudgeResult = {
  lines: [{ line: "lists both pending transfers and neither completed one", source: "case", verdict: "pass", note: "two rows" }],
  degraded: false,
};

const saved = (over: Partial<CaseResult> = {}): CaseResult => ({
  run: "2026-01-01T00-00-00",
  contender: "diy-sonnet",
  model: "claude-sonnet-5",
  case: testCase.id,
  prompt: testCase.prompt,
  lane: testCase.lane,
  shape: testCase.shape,
  floor: STALE,
  timing: { firstRenderMs: 3_900, settledMs: 41_000 },
  cost: { usage: { inputTokens: 9_000, outputTokens: 4_000, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 }, usd: 0.058 },
  islands: 0,
  clientOnly: 0,
  trace: [{ label: "Cancel", changed: false, calls: [{ name: "cancel_transfer", args: { id: "tr_1" } }] }],
  consoleErrors: [],
  world: world.hash,
  caseHash: caseHash(testCase),
  judged: JUDGED_UNDER_V3,
  judgeContract: GRADED_UNDER_V3,
  gitSha: "a".repeat(40),
  agentSdkVersion: "0.3.214",
  ...over,
});

/** One saved run folder, written by the code that writes them, under a `runs`
 *  directory of its own — the real layout, so the sibling `regrade` writes lands
 *  beside it there. */
async function savedRun(results: readonly CaseResult[]): Promise<string> {
  const runDir = join(await mkdtemp(join(tmpdir(), "genbench-regrade-")), "runs", "2026-01-01T00-00-00");
  await mkdir(runDir, { recursive: true });
  for (const result of results) {
    await writeCase(runDir, {
      outcome: { artifact: HTML, blocking: [], format: "html", snapshots: [], settledMs: result.timing.settledMs },
      html: authoredPage(HTML, world, result.contender),
      shot: { png: PNG, tables: [TABLE_PNG], visibleText: "", dom: DOM, renders: true, consoleErrors: [] },
      result,
    });
  }
  return runDir;
}

/** The run folder `regrade` wrote: the one that was not there before. */
async function siblingOf(runDir: string): Promise<string> {
  const beside = (await readdir(dirname(runDir))).filter((name) => name !== basename(runDir));
  expect(beside).toHaveLength(1);
  return join(dirname(runDir), beside[0]!);
}

/** Every text channel the judge was really sent, in the order it assembles them,
 *  so a test reads what went over the wire and not what the caller meant. */
const sent = (call: { prompt: unknown }): string[] => {
  const messages = JSON.parse(JSON.stringify(call.prompt)) as Array<{ content: unknown }>;
  return messages
    .flatMap((message) => (Array.isArray(message.content) ? (message.content as Array<{ text?: string }>) : []))
    .flatMap((part) => part.text ?? []);
};

/** Every picture the judge was really sent, in order: the screenshot, then the
 *  wide tables. The SDK hands an image over as a `file` part whose bytes are
 *  either a byte array or base64, so both readings are put back to bytes. */
const pictures = (call: { prompt: unknown }): Buffer[] =>
  (call.prompt as Array<{ content: unknown }>)
    .flatMap((message) =>
      Array.isArray(message.content) ? (message.content as Array<{ type: string; data?: unknown }>) : [],
    )
    .filter((part) => part.type === "file")
    .map((part) => (typeof part.data === "string" ? Buffer.from(part.data, "base64") : Buffer.from(part.data as Uint8Array)));

/** The grader, doubled: it answers every line it was asked and reports what the
 *  call cost, and it keeps the SOURCE channel and the pictures it was handed so a
 *  test can say where the DOM came from and what the judge could see. */
function grader(): { model: MockLanguageModelV3; source: () => string; shown: () => Buffer[] } {
  let source = "";
  let shown: Buffer[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (call) => {
      const parts = sent(call);
      source = parts.find((part) => part.startsWith("SOURCE")) ?? "";
      shown = pictures(call);
      const asked = [...(parts.at(-1) ?? "").matchAll(/^\s*\d+\./gm)].length;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              verdicts: Array.from({ length: asked }, (_, index) => ({
                line: index + 1,
                verdict: "pass",
                note: "the screenshot shows it",
              })),
            }),
          },
        ],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 20_000, noCache: 20_000, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 600, text: 600, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  return { model, source: () => source, shown: () => shown };
}

const resultIn = async (runDir: string, result: CaseResult): Promise<CaseResult> =>
  JSON.parse(await readFile(join(runDir, result.contender, result.case, "result.json"), "utf8")) as CaseResult;

describe("regrade", () => {
  it("scores the saved screen under today's floor and today's rubric, and re-decides nothing else", async () => {
    const was = saved();
    const runDir = await savedRun([was]);
    const { model, source, shown } = grader();

    expect(await regrade({ runDir, jobs: 1 }, { model })).toBe(0);

    const now = await resultIn(await siblingOf(runDir), was);
    // The rubric moved, so the verdicts are new and carry the contract they were
    // reached under — every line of it, the standing honesty line included.
    expect(now.judgeContract.rubricVersion).toBe(JudgeContract.rubricVersion);
    expect(now.judged.lines).toHaveLength(testCase.pass.length + 1 + world.style.length);
    // The floor is re-decided off the saved trace against today's world: this
    // case presses a live control, and the older verdict said nothing did.
    expect(now.floor.wiredActions).toMatchObject({ pass: true, pressed: 1, acted: "tool" });
    expect(now.floor.pass).toBe(true);
    // And what this pass did not decide is the run's own. How fast the contender
    // was, and what it spent being that fast, are not a re-score's to overwrite;
    // the only new money in the folder is the grader's, on its own line.
    expect(now.timing).toEqual(was.timing);
    expect(now.cost).toEqual(was.cost);
    expect(now.judged.cost?.usd).toBeCloseTo(0.115, 6);
    // The judge read the DOM the run recorded, not a repaint of the page.
    expect(source()).toContain("the DOM the run recorded");
    // And it was shown every picture the run took: the viewport shot, and the
    // wide table at its full width beside it. Dropping the second one would grade
    // the columns past the fold as absent again, which is what it was there for.
    expect(shown()).toEqual([PNG, TABLE_PNG]);
  });

  it("writes a whole run folder beside the source, linking the evidence, and never writes into the source", async () => {
    const was = saved();
    const runDir = await savedRun([was]);
    const from = join(runDir, was.contender, was.case);
    const before = await readFile(join(from, "result.json"), "utf8");

    expect(await regrade({ runDir, jobs: 1 }, { model: grader().model })).toBe(0);

    const regraded = await siblingOf(runDir);
    const to = join(regraded, was.contender, was.case);
    // A complete run: the aggregate, the page a person opens, and the case's own
    // evidence beside its new verdicts.
    const summary = JSON.parse(await readFile(join(regraded, "summary.json"), "utf8")) as RunSummary;
    expect(summary.regradedFrom).toBe(basename(runDir));
    expect(summary.run).toBe(basename(regraded));
    expect(summary.columns[was.contender]?.settledMs).toEqual({ median: 41_000, p90: 41_000, worst: 41_000 });
    expect(await readFile(join(regraded, "preview.html"), "utf8")).toContain(was.contender);
    // The evidence itself is the same FILE, not a second copy of it: a regraded
    // corpus is 200 screenshots and 200 pages that did not change.
    for (const name of ["page.html", "screenshot.png", "dom.html", "table-1.png"]) {
      expect((await stat(join(to, name))).ino).toBe((await stat(join(from, name))).ino);
    }
    // The verdicts are the one thing written fresh, and the source run is
    // evidence: a pass that edits its own input can only be run once.
    expect((await stat(join(to, "result.json"))).ino).not.toBe((await stat(join(from, "result.json"))).ino);
    expect(await readFile(join(from, "result.json"), "utf8")).toBe(before);
  });

  /**
   * The screen was built against a product that has since changed, so today's
   * tool data is not the data it was given and today's pass lines are not what
   * it was asked. Grading it anyway would report the edit as the contender's
   * score — quietly, in a folder that looks like every other folder.
   */
  it("refuses a case whose world or case has moved since, and keeps its siblings", async () => {
    const stale = saved({ contender: "vendo-sonnet", world: "0".repeat(16) });
    const runDir = await savedRun([saved(), stale]);

    expect(await regrade({ runDir, jobs: 2 }, { model: grader().model })).toBe(1);

    const regraded = await siblingOf(runDir);
    // The healthy sibling is graded and complete…
    expect((await resultIn(regraded, saved())).floor.pass).toBe(true);
    // …and the one whose stamps match nothing is nowhere in the new run.
    const summary = JSON.parse(await readFile(join(regraded, "summary.json"), "utf8")) as RunSummary;
    expect(Object.keys(summary.columns)).toEqual([saved().contender]);
    expect(await readdir(join(regraded, stale.contender)).catch(() => undefined)).toBeUndefined();
  });

  /** `runs/` is one keystroke from `runs/<id>`, and read whole it is every run
   *  at once — a judge call per case, into one folder where two runs' cases
   *  overwrite each other. A result names the folder it belongs in, so a folder
   *  that is not one run says so before anything is graded. */
  it("refuses a path that is not one run folder, rather than reading every run under it", async () => {
    const runDir = await savedRun([saved()]);

    expect(await regrade({ runDir: dirname(runDir), jobs: 1 }, { model: grader().model })).toBe(1);

    const summary = JSON.parse(
      await readFile(join(await siblingOf(dirname(runDir)), "summary.json"), "utf8"),
    ) as RunSummary;
    expect(summary.columns).toEqual({});
  });

  /** Every run recorded before `writeCase` saved the DOM — the pilot included —
   *  has only the page. The judge's SOURCE is what the browser HOLDS once the
   *  screen has settled, script bodies dropped, so it is recovered by painting
   *  the saved page and reading it back, and never by re-probing it. */
  it("recovers the settled DOM by painting the saved page, for a run that recorded none", async () => {
    const was = saved();
    const runDir = await savedRun([was]);
    await rm(join(runDir, was.contender, was.case, "dom.html"));
    const { model, source } = grader();

    expect(await regrade({ runDir, jobs: 1 }, { model })).toBe(0);

    // What the page really painted, and not the file: the bytes on disk carry the
    // harness's own injected scripts, and the DOM the judge reads carries none.
    expect(source()).toContain("2 pending transfers");
    expect(source()).not.toContain("window.vendo");
    expect(source()).not.toContain("the DOM the run recorded");
    // The trace is still the saved one — the screen was painted, never pressed.
    expect((await resultIn(await siblingOf(runDir), was)).trace).toEqual(was.trace);
  }, 120_000);
});
