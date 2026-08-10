/**
 * Every contender for a case runs at once, so one column's crash or one
 * column's silence has to stay its own. `attempt` is where that is decided: it
 * turns a driver's exception and a driver's hang into ordinary results, which is
 * what lets the row be gathered with `Promise.all` — and so what keeps the
 * report's column order the contender order, whatever order they finish in.
 */
import { describe, expect, it, vi } from "vitest";
import { WALL_CLOCK_MS } from "../src/claude-code.js";
import type { FloorResult } from "../src/floor.js";
import { JudgeContract, type JudgeResult } from "../src/judge.js";
import { caseHash, type Case } from "../src/world.js";
import {
  attempt,
  CASE_TIMEOUT_MS,
  contenders,
  exitCode,
  parseArgs,
  resolveCase,
  shouldOpen,
  ungraded,
  type Args,
  type CaseResult,
} from "../src/run.js";

describe("attempt", () => {
  it("hands back what the work returned", async () => {
    expect(await attempt(async () => "a screen", 1_000)).toEqual({ done: "a screen" });
  });

  it("keeps a healthy sibling when one contender throws and another never answers", async () => {
    const row = await Promise.all([
      attempt(async () => "vendo", 100),
      attempt(async () => {
        throw new Error("diy exploded");
      }, 100),
      attempt(() => new Promise<string>(() => undefined), 100),
    ]);

    expect(row).toEqual([{ done: "vendo" }, { failure: "diy exploded" }, { failure: "timeout" }]);
  });

  /**
   * Losing the race does not stop the work — nothing here can reach inside a
   * driver mid-generation — so the work has to be able to ASK.
   *
   * Without that, a column whose budget expired still walks on to open a page on
   * the browser every other column is being shot on, one or two cases later,
   * with nobody waiting for the result. `runOne` checks this before it visits.
   */
  it("tells the work it lost, so a timed-out case can stop reaching for the shared browser", async () => {
    let toldItLost: boolean | undefined;
    const result = await attempt(async (lost) => {
      await new Promise((settle) => setTimeout(settle, 30));
      toldItLost = lost.aborted;
      return "a screen nobody is waiting for";
    }, 5);

    expect(result).toEqual({ failure: "timeout" });
    await vi.waitFor(() => expect(toldItLost).toBe(true));
  });

  it("never tells work that won that it lost", async () => {
    let toldItLost: boolean | undefined;
    await attempt(async (lost) => {
      toldItLost = lost.aborted;
      return "a screen";
    }, 1_000);

    expect(toldItLost).toBe(false);
  });
});

describe("contenders", () => {
  it("lists every driver in one fixed order, so the columns never shuffle", () => {
    expect(contenders(["sonnet"]).map((contender) => contender.slug)).toEqual([
      "vendo-sonnet",
      "diy-sonnet",
      "claude-code-sonnet",
    ]);
  });

  it("gives each contender its own slug per model", () => {
    expect(contenders(["sonnet", "haiku"]).map((contender) => contender.slug)).toEqual([
      "vendo-sonnet",
      "vendo-haiku",
      "diy-sonnet",
      "diy-haiku",
      "claude-code-sonnet",
      "claude-code-haiku",
    ]);
  });
});

describe("the case budget", () => {
  /** The bound is per contender, not one number for the row. An agentic column
   *  spends ten minutes inside its own driver before it has delivered anything;
   *  ending its case at five would report a timeout the contender never had,
   *  which is measuring the harness. */
  it("outlasts the claude-code driver's own wall clock, with room left to paint and probe", () => {
    expect(CASE_TIMEOUT_MS["claude-code"]).toBeGreaterThan(WALL_CLOCK_MS);
  });

  it("leaves the one-call columns on the tighter bound they never needed more than", () => {
    expect(CASE_TIMEOUT_MS.vendo).toBe(5 * 60_000);
    expect(CASE_TIMEOUT_MS.diy).toBe(5 * 60_000);
  });
});

// ---------------------------------------------------------------- the verdict

const floorAt = (pass: boolean): FloorResult => ({
  delivered: pass,
  renders: pass,
  valid: pass,
  blocking: [],
  honestData: { pass, offenders: [], examined: 0 },
  wiredActions: { pass, bindings: [] },
  pass,
});

const LINE = "shows every pending transfer the tool returned";

const scored = (floor: FloorResult, judged: JudgeResult): CaseResult => ({
  run: "run-1",
  contender: "vendo-sonnet",
  model: "claude-sonnet-5",
  case: "pending-transfers",
  prompt: "Show my pending transfers.",
  lane: "screen",
  floor,
  timing: { settledMs: 1 },
  cost: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 }, usd: 0 },
  islands: 0,
  clientOnly: 0,
  trace: [],
  consoleErrors: [],
  world: "hash",
  caseHash: "case-hash",
  judged,
  judgeContract: JudgeContract,
});

/**
 * The founder runs this in a live loop, and the judge is a third party that can
 * be having a bad afternoon. So the floor — which is mechanical, local and
 * cannot be unwell — is the only thing the exit code reads. A degraded
 * judgement is loud in `result.json` and in the preview instead.
 */
describe("the exit code", () => {
  it("survives a judge that went down, because a judge outage is not the contender's failure", () => {
    const degraded: JudgeResult = {
      lines: [{ line: LINE, source: "case", verdict: "fail", note: "the judge did not grade this screen" }],
      degraded: true,
      error: "529 overloaded",
    };

    expect(exitCode([scored(floorAt(true), degraded)])).toBe(0);
  });

  it("survives a screen the judge graded down, because a failed rubric line is the benchmark's finding", () => {
    const failed: JudgeResult = {
      lines: [{ line: LINE, source: "case", verdict: "fail", note: "no transfers are listed" }],
      degraded: false,
    };

    expect(exitCode([scored(floorAt(true), failed)])).toBe(0);
  });

  it("still fails a run whose floor failed", () => {
    const passed: JudgeResult = {
      lines: [{ line: LINE, source: "case", verdict: "pass", note: "six rows are listed" }],
      degraded: false,
    };

    expect(exitCode([scored(floorAt(false), passed)])).toBe(1);
  });
});

describe("a column with no screen", () => {
  it("fails every rubric line without spending a judge call, and does not call that the judge's failure", () => {
    expect(ungraded(["shows every pending transfer"], ["money always shows 2 decimals"])).toEqual({
      lines: [
        { line: "shows every pending transfer", source: "case", verdict: "fail", note: "no screen was delivered to grade" },
        { line: "money always shows 2 decimals", source: "style", verdict: "fail", note: "no screen was delivered to grade" },
      ],
      degraded: false,
    });
  });
});

/**
 * A window is a thing a person asked for, not something a run does to whoever
 * started it. `--prompt` is one case under one pair of eyes; a full run, a build
 * agent, and anyone who opted out get the path on stdout instead.
 */
describe("opening the preview", () => {
  const args = (only?: string): Args => ({
    ...(only === undefined ? {} : { only }),
    lane: "screen",
    models: ["sonnet"],
    world: "maple",
  });

  it("opens for the single case a person is sitting and watching", () => {
    expect(shouldOpen(args("pending-transfers"), {})).toBe(true);
  });

  it("leaves a full run to the path it prints, rather than stealing focus mid-row", () => {
    expect(shouldOpen(args(), {})).toBe(false);
  });

  it("never opens under CI, where a window is a hang and not a preview", () => {
    expect(shouldOpen(args("pending-transfers"), { CI: "true" })).toBe(false);
  });

  it("never opens when the environment says not to", () => {
    expect(shouldOpen(args("pending-transfers"), { GENBENCH_NO_OPEN: "1" })).toBe(false);
  });
});

describe("parseArgs", () => {
  it("runs maple, the only world there is, when none is named", () => {
    expect(parseArgs(["run"]).world).toBe("maple");
  });

  it("takes the world by folder name", () => {
    expect(parseArgs(["run", "--world", "sienna", "--prompt", "spend-overview"])).toMatchObject({
      world: "sienna",
      only: "spend-overview",
    });
  });

  it("takes a cases file that lives somewhere else, and a repeat index", () => {
    expect(parseArgs(["run", "--cases", "/held-out/maple/cases.json", "--repeat", "2"])).toMatchObject({
      cases: "/held-out/maple/cases.json",
      repeat: 2,
      world: "maple",
    });
  });

  it("refuses a repeat that is not a whole number", () => {
    expect(() => parseArgs(["run", "--repeat", "1.5"])).toThrow(/whole number/);
    expect(() => parseArgs(["run", "--repeat", "-1"])).toThrow(/whole number/);
  });

  it("knows the harness lane and still refuses one nobody has", () => {
    expect(parseArgs(["run", "--lane", "harness"]).lane).toBe("harness");
    expect(() => parseArgs(["run", "--lane", "vibes"])).toThrow(/unknown lane/);
  });
});

/**
 * A repeat measures the product against a different PHRASING, not the same
 * sentence twice — and it does it by resolving the case, so everything
 * downstream (the driver, the report, `caseHash`) sees an ordinary case whose
 * prompt is the one that was actually asked.
 */
describe("resolveCase", () => {
  const testCase = (over: Partial<Case> = {}): Case => ({
    id: "c",
    lane: "screen",
    prompt: "the authored ask",
    pass: [],
    ...over,
  });

  it("leaves a case with no samples exactly as authored", () => {
    const only = testCase();
    expect(resolveCase(only, 3)).toBe(only);
  });

  it("takes the first sample by default", () => {
    expect(resolveCase(testCase({ prompts: ["one", "two"] }), 0).prompt).toBe("one");
  });

  it("walks the samples round-robin, so a fourth repeat of three phrasings is the first again", () => {
    const three = testCase({ prompts: ["one", "two", "three"] });
    expect([0, 1, 2, 3].map((repeat) => resolveCase(three, repeat).prompt)).toEqual(["one", "two", "three", "one"]);
  });

  /** The stamp has to move with the sentence: two phrasings that hashed the same
   *  would compare as one another's repeats. */
  it("changes the case's stamp with the sample", () => {
    const two = testCase({ prompts: ["one", "two"] });
    expect(caseHash(resolveCase(two, 0))).not.toBe(caseHash(resolveCase(two, 1)));
  });
});
