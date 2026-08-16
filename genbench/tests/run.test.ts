/**
 * Every contender for a case runs at once, so one column's crash or one
 * column's silence has to stay its own. `attempt` is where that is decided: it
 * turns a driver's exception and a driver's hang into ordinary results, which is
 * what lets the row be gathered with `Promise.all` — and so what keeps the
 * report's column order the contender order, whatever order they finish in.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { WALL_CLOCK_MS } from "../src/claude-code.js";
import type { FloorResult } from "../src/floor.js";
import { AUDITOR_CONTRACT } from "../src/audit.js";
import { JudgeContract, type JudgeResult } from "../src/judge.js";
import {
  attempt,
  CASE_TIMEOUT_MS,
  contenders,
  exitCode,
  harnessStamp,
  parseArgs,
  pool,
  shouldOpen,
  ungraded,
  worldsFor,
  type Args,
  type CaseResult,
} from "../src/run.js";
import { TriageContract } from "../src/triage.js";

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
  honestData: { pass, offenders: [], examined: 0, found: 0 },
  wiredActions: { pass, pressed: 0, bindings: [] },
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
  shape: "table",
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
  triageContract: TriageContract,
  auditorContract: AUDITOR_CONTRACT,
  gitSha: "0".repeat(40),
  agentSdkVersion: "0.0.0",
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
    models: ["sonnet"],
    world: "maple",
    contenders: ["vendo", "diy", "claude-code"],
    jobs: 1,
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
  it("runs maple when no world is named", () => {
    expect(parseArgs(["run"]).world).toBe("maple");
  });

  it("takes the world by folder name", () => {
    expect(parseArgs(["run", "--world", "sienna", "--prompt", "spend-overview"])).toMatchObject({
      world: "sienna",
      only: "spend-overview",
    });
  });
});

/**
 * `--world` took exactly one folder, so fourteen worlds meant fourteen runs into
 * fourteen disconnected folders and no number anywhere covering the corpus.
 */
describe("worldsFor", () => {
  const worldsDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "worlds");

  it("takes one named world as itself, without looking at the disk", async () => {
    expect(await worldsFor(worldsDir, "maple")).toEqual(["maple"]);
  });

  it("takes `all` as every world folder there is, in a fixed order", async () => {
    const all = await worldsFor(worldsDir, "all");

    expect(all).toContain("maple");
    expect(all).toContain("buildlog");
    expect(all).toEqual([...all].sort());
    expect(all.length).toBeGreaterThan(1);
  });
});

/**
 * A result named its models and its rubric version and nothing about the tree it
 * was produced from — so the product under test could change completely between
 * two runs and every stamp in `result.json` would still match.
 */
describe("harnessStamp", () => {
  it("names the commit the harness ran at and the engine the agentic column ran on", async () => {
    const stamp = await harnessStamp(dirname(dirname(fileURLToPath(import.meta.url))));

    expect(stamp.gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(stamp.agentSdkVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});

/** `--models` is the only door into a run, so an alias nothing serves is refused
 *  at the flag rather than at the first model call, a case and a browser later. */
describe("--models", () => {
  it("takes the Wafer-served open-source contenders", () => {
    expect(parseArgs(["run", "--models", "glm-fast,deepseek-flash"]).models).toEqual(["glm-fast", "deepseek-flash"]);
  });

  it("refuses a model no provider here serves", () => {
    expect(() => parseArgs(["run", "--models", "gpt-9"])).toThrow(/unknown model "gpt-9"/);
  });
});

/** A row is every driver, and the reason to narrow it is money: measuring one
 *  harness should not spend the other two's tokens on the same case. */
describe("--contenders", () => {
  it("races every driver when nobody narrows the row", () => {
    expect(parseArgs(["run"]).contenders).toEqual(["vendo", "diy", "claude-code"]);
  });

  it("narrows the row to the drivers named", () => {
    const only = parseArgs(["run", "--contenders", "vendo,claude-code"]).contenders;

    expect(contenders(["sonnet"], only).map((contender) => contender.slug)).toEqual([
      "vendo-sonnet",
      "claude-code-sonnet",
    ]);
  });

  it("refuses a contender that has no driver", () => {
    expect(() => parseArgs(["run", "--contenders", "vendo,langchain"])).toThrow(/unknown contender "langchain"/);
  });

  /** Claude Code is Anthropic's own engine and never reads the meter's model, so
   *  a Wafer alias would reach its Agent SDK as an Anthropic id — a column that
   *  scores zero for a mistake the harness made. It has no such column. */
  it("leaves Claude Code out of a Wafer model's row, and keeps the rest of it", () => {
    expect(contenders(["glm-fast"]).map((contender) => contender.slug)).toEqual(["vendo-glm-fast", "diy-glm-fast"]);
    expect(contenders(["sonnet", "glm-fast"]).map((contender) => contender.slug)).toContain("claude-code-sonnet");
  });
});

/** Within a case the contenders already race each other. `--jobs` is the bound
 *  ACROSS cases — the only thing between a 200-case corpus and one case at a
 *  time — and a bound that is not a whole number of cases is not a bound. */
describe("--jobs", () => {
  it("runs one case at a time unless asked otherwise", () => {
    expect(parseArgs(["run"]).jobs).toBe(1);
  });

  it("takes the number of cases to keep in flight", () => {
    expect(parseArgs(["run", "--jobs", "4"]).jobs).toBe(4);
  });

  it("refuses anything that is not a whole number of cases", () => {
    for (const value of ["0", "-1", "2.5", "lots"]) {
      expect(() => parseArgs(["run", "--jobs", value])).toThrow(/--jobs/);
    }
  });
});

describe("pool", () => {
  it("keeps results in the jobs' own order, not the order they finished", async () => {
    const jobs = [30, 1, 15].map((ms, index) => async () => {
      await new Promise((settle) => setTimeout(settle, ms));
      return index;
    });

    expect(await pool(jobs, 3)).toEqual([0, 1, 2]);
  });

  it("never has more than the bound in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const jobs = Array.from({ length: 7 }, () => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((settle) => setTimeout(settle, 5));
      inFlight -= 1;
    });

    await pool(jobs, 2);

    expect(peak).toBe(2);
  });

  it("runs every job when the bound is wider than the queue, and none when there are none", async () => {
    expect(await pool([async () => "the only case"], 8)).toEqual(["the only case"]);
    expect(await pool([], 8)).toEqual([]);
  });
});
