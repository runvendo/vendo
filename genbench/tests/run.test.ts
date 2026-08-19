/**
 * Every contender for a case runs at once, so one column's crash or one
 * column's silence has to stay its own. `attempt` is where that is decided: it
 * turns a driver's exception and a driver's hang into ordinary results, which is
 * what lets the row be gathered with `Promise.all` — and so what keeps the
 * report's column order the contender order, whatever order they finish in.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { WALL_CLOCK_MS } from "../src/claude-code.js";
import type { FloorResult } from "../src/floor.js";
import { HonestyContract } from "../src/honesty.js";
import { HONESTY_LINE, JudgeContract, type JudgeResult } from "../src/judge.js";
import { usdFor } from "../src/meter.js";
import type { RunSummary } from "../src/report.js";
import {
  attempt,
  CASE_TIMEOUT_MS,
  contenders,
  door,
  exitCode,
  harnessStamp,
  missingKey,
  parseArgs,
  parseRegrade,
  parseReport,
  pool,
  report,
  SALVAGE_MS,
  shouldOpen,
  ungraded,
  unjudged,
  worldsFor,
  writeCase,
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

  /**
   * A screen painted before the bell is a real screen, and it used to be thrown
   * away: the case was recorded as a timeout, the floor failed `delivered`, and
   * a judge failed every rubric line on a screen that existed. So the budget is
   * announced a salvage window BEFORE the case is recorded, and a driver that
   * answers it is reported as having delivered — with the cap riding along as
   * its own failure sentence rather than instead of the screen.
   */
  it(
    "asks the work for what it has before the case is recorded, and reports what it hands back",
    async () => {
      const salvaged = await attempt(async (lost, spent) => {
        await new Promise((settle) => spent.addEventListener("abort", settle, { once: true }));
        // A salvage is not free, and this is why the window is a window and not
        // a promise resolved on the way past: the driver reads back what landed,
        // re-runs the product's gate on it, then the case paints and presses the
        // screen. Anything real after the ask lands on the far side of the bell.
        await new Promise((settle) => setTimeout(settle, 20));
        // Nobody's timeout yet: the case has not been recorded, so what this
        // hands back is what the case gets.
        return lost.aborted ? "a screen nobody is waiting for" : "the last screen it painted";
      }, SALVAGE_MS + 50);

      expect(salvaged).toEqual({ done: "the last screen it painted" });
    },
    // The ask lands 50ms in, so this passes in 50ms. The budget itself is a
    // salvage window plus that, which is longer than the suite's own default —
    // and a version that only asks at the bell has to be allowed to reach the
    // bell, or this reads as a hang instead of the wrong answer.
    SALVAGE_MS + 15_000,
  );
});

/**
 * The zombie that killed a run: a case hit its budget, the row moved on, and the
 * driver that was still going rejected — an audit write into a store already
 * closed — with nobody left to catch it. Node ends a process over that, and it
 * did: 38 other cases' work sat on disk and `summary.json` was never written.
 *
 * Proven in a REAL child process, because "the process does not die" is not
 * something this one can answer — vitest listens for unhandled rejections too,
 * and a handler tested against a stand-in proves only the stand-in.
 */
describe("a late failure", () => {
  const zombie = `
import { surviveLateFailures } from ${JSON.stringify(pathToFileURL(join(dirname(dirname(fileURLToPath(import.meta.url))), "src", "run.ts")).href)};
surviveLateFailures(new Set(["vendo-sonnet / spend-by-merchant"]));
// The crash, verbatim: the timed-out case's guard, writing its row moments too late.
Promise.reject(new Error("[vendo] store is closed"));
await new Promise((settle) => setTimeout(settle, 50));
console.log("the run wrote its summary");
`;

  it("does not take the rest of the run down with it", () => {
    const ran = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", zombie], {
      cwd: dirname(dirname(fileURLToPath(import.meta.url))),
      encoding: "utf8",
    });

    // The run reached its end — the process outlived the rejection.
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("the run wrote its summary");
    // And said so, once and loudly: what it was, and what was running beside it.
    expect(ran.stderr).toContain("LATE FAILURE");
    expect(ran.stderr).toContain("[vendo] store is closed");
    expect(ran.stderr).toContain("vendo-sonnet / spend-by-merchant");
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

  /** The salvage window is carved OUT of these numbers rather than added to
   *  them, so a case still fits in one budget. A window as long as a column's
   *  whole budget would tell that column it was over before it started. */
  it("leaves every column room to generate inside its own budget", () => {
    for (const [harness, budget] of Object.entries(CASE_TIMEOUT_MS)) {
      expect(budget, harness).toBeGreaterThan(SALVAGE_MS);
    }
  });
});

// ---------------------------------------------------------------- the verdict

const floorAt = (pass: boolean): FloorResult => ({
  delivered: pass,
  renders: pass,
  valid: pass,
  blocking: [],
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
        // The standing honesty line rides along, so a column that delivered
        // nothing is failed on it too rather than quietly skipping it.
        { line: HONESTY_LINE, source: "case", verdict: "fail", note: "no screen was delivered to grade" },
        { line: "money always shows 2 decimals", source: "style", verdict: "fail", note: "no screen was delivered to grade" },
      ],
      degraded: false,
      // And the honesty fail says who did not check it, rather than being a fail
      // with nothing beside it — the shape that left two accusations unexplained
      // in run 2026-08-18T21-39-10.
      honesty: {
        judged: "fail",
        claim: "no screen was delivered to grade",
        verdict: "unadjudicated",
        note: "no screen was delivered, so this screen displayed no figures to audit",
        adjudicator: HonestyContract,
      },
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
    floorOnly: false,
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

  it("takes a comma list as those worlds, in the order they were written", async () => {
    expect(await worldsFor(worldsDir, parseArgs(["run", "--world", "buildlog,maple"]).world)).toEqual([
      "buildlog",
      "maple",
    ]);
  });

  /** The folder name is the evidence key the same way a slug is: `maple,maple`
   *  wrote every contender's `maple/<case>` folder twice, the second pass
   *  replacing the first's artifacts while both counted in the summary. And a
   *  name beside `all` asks for nothing `all` does not already cover. */
  it("takes a world named twice as that world once, and `all` beside a name as the whole corpus", async () => {
    expect(await worldsFor(worldsDir, "maple,maple")).toEqual(["maple"]);
    expect(await worldsFor(worldsDir, "maple,all")).toEqual(await worldsFor(worldsDir, "all"));
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
  /** A bare run is every contender once, each on the model its column is bought
   *  for — and all of them in one price band, because a flagship set against
   *  another vendor's mid-tier measures a price tag rather than a product. */
  it("races every contender on one price band when nobody narrows the row", () => {
    // `opus` is passed and ignored: every column in the default row is a pinned
    // pair, because crossing `--models` over it would hand `diy` the same Sonnet
    // 5 twice — once first-party, once through the router.
    expect(contenders(["opus"], parseArgs(["run"]).contenders).map((contender) => contender.slug)).toEqual([
      "vendo-sonnet",
      "diy-claude",
      "diy-gpt",
      "diy-gemini",
      "claude-code-sonnet",
      "thesys-c1",
      "codex-terra",
    ]);
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

  /** The matrix stopped being a rectangle once some columns had a model line of
   *  their own: naming a model to get one column of it also crossed that model
   *  onto every other harness in the list. A `harness:model` pair is one column. */
  it("takes a harness:model pair as exactly that column, and leaves --models out of it", () => {
    const only = parseArgs(["run", "--contenders", "diy:gpt"]).contenders;

    expect(contenders(["sonnet", "haiku"], only).map((contender) => contender.slug)).toEqual(["diy-gpt"]);
  });

  it("mixes bare harnesses and pairs, and keeps the order they were written in", () => {
    const only = parseArgs(["run", "--contenders", "claude-code,diy:gemini,vendo"]).contenders;

    expect(contenders(["sonnet"], only).map((contender) => contender.slug)).toEqual([
      "claude-code-sonnet",
      "diy-gemini",
      "vendo-sonnet",
    ]);
  });

  /** A bare harness and a pinned pair can name the same column, and the slug is
   *  the evidence directory: two of them would race to overwrite one
   *  `vendo-sonnet/<case>` folder and be counted twice in the summary. Asking for
   *  a column twice is asking for that column. */
  it("collapses a column named twice into the one column, where it was first named", () => {
    const only = parseArgs(["run", "--contenders", "diy:gemini,vendo,vendo:sonnet"]).contenders;

    expect(contenders(["sonnet"], only).map((contender) => contender.slug)).toEqual(["diy-gemini", "vendo-sonnet"]);
  });

  it("refuses a pair naming a model or a harness nothing here has", () => {
    expect(() => parseArgs(["run", "--contenders", "diy:gpt-9"])).toThrow(/unknown model "gpt-9"/);
    expect(() => parseArgs(["run", "--contenders", "langchain:sonnet"])).toThrow(/unknown contender "langchain"/);
  });

  /** Claude Code is Anthropic's own engine and never reads the meter's model, so
   *  a Wafer alias would reach its Agent SDK as an Anthropic id — a column that
   *  scores zero for a mistake the harness made. It has no such column. */
  it("leaves Claude Code out of a Wafer model's row, and keeps the rest of it", () => {
    expect(contenders(["glm-fast"]).map((contender) => contender.slug)).toEqual(["vendo-glm-fast", "diy-glm-fast"]);
    expect(contenders(["sonnet", "glm-fast"]).map((contender) => contender.slug)).toContain("claude-code-sonnet");
  });

  /** That filter is also the one way to ask for a row with no columns in it. The
   *  run used to build the row inside each case, so an empty one opened a
   *  browser and then died as `no case matches --prompt` — the wrong thing,
   *  named late. */
  it("refuses a row nothing can run, naming the pairing that emptied it", () => {
    expect(() => contenders(["glm-fast"], ["claude-code"])).toThrow(/claude-code has no column for glm-fast/);
  });

  /** The router's three aliases are the cross-VENDOR row, and `diy` — one model
   *  call with no product around it — is what makes three vendors comparable.
   *  Elsewhere they would double a column that already exists first-party, and a
   *  pair that asks for one is a row nothing can run, named as it was written. */
  it("keeps the OpenRouter aliases to the one column that is nothing but a model", () => {
    expect(contenders(["gpt", "gemini"]).map((contender) => contender.slug)).toEqual(["diy-gpt", "diy-gemini"]);
    expect(() => contenders(["sonnet"], parseArgs(["run", "--contenders", "vendo:claude"]).contenders)).toThrow(
      /vendo:claude has no column/,
    );
  });

  /** `codex` is a bought PRODUCT the way `thesys` is: it spawns OpenAI's own CLI
   *  and never reads the meter's model, so it runs its one alias and nothing
   *  else. That alias goes exactly one place beyond it — the vendo pipeline —
   *  and nowhere near the two columns that spawn an engine of their own. */
  it("runs the Codex CLI on its own alias, and lends that alias to the vendo column alone", () => {
    expect(contenders(["terra"]).map((contender) => contender.slug)).toEqual(["vendo-terra", "codex-terra"]);
    expect(contenders(["sonnet", "terra"]).map((contender) => contender.slug)).not.toContain("codex-sonnet");
  });

  /** Every other pair of columns moves the harness and the model at once, so the
   *  gap between them says nothing about which one moved. This is the pair that
   *  holds the model still. */
  it("takes the borrowed column as the pair it was asked for", () => {
    const only = parseArgs(["run", "--contenders", "vendo:terra"]).contenders;

    expect(contenders([], only).map((contender) => contender.slug)).toEqual(["vendo-terra"]);
  });
});

/** An alias only means something at a door, and the meter prices what the WIRE
 *  answered. `terra` is the one alias with two doors, so it is the one that says
 *  whether a column is priced where it really ran. */
describe("the door a column answers at", () => {
  it("sends the borrowed column through the router, under the id the router bills", () => {
    expect(door({ harness: "vendo", model: "terra", slug: "vendo-terra" })).toEqual({
      at: "openrouter",
      modelId: "openai/gpt-5.6-terra",
    });
  });

  /** The CLI is billed by OpenAI's platform directly rather than through the
   *  router, so the two columns cannot share an id even though both now price at
   *  the same list rate. */
  it("leaves the codex column on OpenAI's own id, which is what prices its session", () => {
    expect(door({ harness: "codex", model: "terra", slug: "codex-terra" }).modelId).toBe("gpt-5.6-terra");
  });

  it("keeps every other column at the door it already had", () => {
    expect(door({ harness: "vendo", model: "sonnet", slug: "vendo-sonnet" })).toEqual({
      at: "anthropic",
      modelId: "claude-sonnet-5",
    });
    expect(door({ harness: "diy", model: "gpt", slug: "diy-gpt" }).at).toBe("openrouter");
    expect(door({ harness: "vendo", model: "glm-fast", slug: "vendo-glm-fast" }).at).toBe("wafer");
    expect(door({ harness: "thesys", model: "c1", slug: "thesys-c1" }).at).toBe("thesys");
  });

  /** Both doors are priced at Terra's list rate on purpose — not the router's
   *  temporary discount on its OpenAI endpoint — so the two columns compare on
   *  the same dollar and a coupon that can expire any day flatters neither. */
  it("prices both terra doors the same, at the list rate", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 };

    expect(usdFor(usage, door({ harness: "vendo", model: "terra", slug: "vendo-terra" }).modelId)).toBe(2);
    expect(usdFor(usage, door({ harness: "codex", model: "terra", slug: "codex-terra" }).modelId)).toBe(2);
  });
});

/**
 * A key is demanded up front — before a case and a browser — and only for a
 * column that will really run. It reads the resolved ROW rather than `--models`,
 * so narrowing `--contenders` can never leave a key demanded for a column nobody
 * asked for.
 */
describe("the credential preflight", () => {
  it("demands the router's key for a row that runs an OpenRouter alias", () => {
    expect(missingKey(contenders(["gpt"]), {})).toMatch(/OPENROUTER_API_KEY is not set.*serves gpt/);
    expect(missingKey(contenders(["gpt"]), { OPENROUTER_API_KEY: "sk-or-x" })).toBeUndefined();
  });

  it("demands OpenAI's key for the codex column, which bills that account directly", () => {
    const only = parseArgs(["run", "--contenders", "codex:terra"]).contenders;

    expect(missingKey(contenders([], only), {})).toMatch(/OPENAI_API_KEY is not set.*serves terra/);
    expect(missingKey(contenders([], only), { OPENAI_API_KEY: "sk-x" })).toBeUndefined();
  });

  /** Same alias, other door: the borrowed column reaches `terra` over the
   *  router's wire and owes the router's key, and OpenAI's platform key would
   *  buy it nothing. A key demanded off the alias would ask for the wrong one. */
  it("demands the router's key for the borrowed column, and not OpenAI's", () => {
    const only = parseArgs(["run", "--contenders", "vendo:terra"]).contenders;

    expect(missingKey(contenders([], only), {})).toMatch(/OPENROUTER_API_KEY is not set.*serves terra/);
    expect(missingKey(contenders([], only), { OPENROUTER_API_KEY: "sk-or-x" })).toBeUndefined();
  });

  it("demands nothing for an alias the narrowed row dropped", () => {
    expect(missingKey(contenders(["sonnet", "gpt", "c1"], ["vendo"]), {})).toBeUndefined();
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

/**
 * The cheap sweep.
 *
 * A floor is mechanical, local and deterministic, so it can be run over all
 * fourteen worlds the day something lands — but only if it costs no grader. At
 * ~$0.03 a case a judged 200-case sweep is $6 of verdicts nobody asked to
 * change, and a regression gate that expensive is a gate nobody runs.
 */
describe("--floor-only", () => {
  it("asks the judge unless a run says not to", () => {
    expect(parseArgs(["run"]).floorOnly).toBe(false);
  });

  /** It names a MODE, so it takes no value — and every flag beside it still
   *  parses exactly as it does in a judged run. */
  it("takes no value, and leaves the flags beside it their own", () => {
    expect(parseArgs(["run", "--world", "all", "--floor-only", "--jobs", "4"])).toMatchObject({
      floorOnly: true,
      world: "all",
      jobs: 4,
    });
    expect(
      contenders(["sonnet"], parseArgs(["run", "--floor-only", "--contenders", "vendo"]).contenders).map(
        (contender) => contender.slug,
      ),
    ).toEqual(["vendo-sonnet"]);
  });

  it("still refuses an argument nothing here takes", () => {
    expect(() => parseArgs(["run", "--floor-only", "--rubric", "4"])).toThrow(/unexpected argument "--rubric"/);
  });

  /** Three different silences, and only one of them is about the contender: a
   *  column that delivered nothing fails every line, a judge that was unwell
   *  fails every line and says so, and a run that never asked has no lines at
   *  all — so nothing downstream can count a skipped exam against anyone. */
  it("records a skipped judgement as no rubric, never as a failed one", () => {
    expect(unjudged).toEqual({ lines: [], degraded: false });
    expect(ungraded(["shows every pending transfer"], []).lines.every((line) => line.verdict === "fail")).toBe(true);
  });
});

/** The second subcommand. Re-scoring a run folder takes the folder and nothing
 *  else, so the folder is positional — and `--jobs` means there what it means in
 *  a run, because a judge call per case is still a queue. */
describe("regrade", () => {
  it("takes the run folder to re-score, and one case at a time unless asked otherwise", () => {
    expect(parseRegrade(["runs/2026-08-17T09-09-03"])).toEqual({
      runDir: resolve("runs/2026-08-17T09-09-03"),
      jobs: 1,
    });
    expect(parseRegrade(["runs/x", "--jobs", "4"]).jobs).toBe(4);
  });

  it("refuses a regrade with no folder, and a flag a re-score has no meaning for", () => {
    expect(() => parseRegrade([])).toThrow(/needs the run folder/);
    expect(() => parseRegrade(["runs/x", "--models", "opus"])).toThrow(/unexpected argument "--models"/);
  });
});

/**
 * The third subcommand, and the only one that spends nothing.
 *
 * How the report READS a run moves without a single verdict moving — correctness
 * just split the honesty line out into a column of its own — and `regrade` would
 * answer that with a judge call per case, for verdicts nobody disputes. So both
 * real halves over one real directory: the run's OWN writer puts a case on disk,
 * `report` rewrites the two files that are read off it, and these read those
 * back.
 */
describe("report", () => {
  it("takes the run folder to read back, and nothing else", () => {
    expect(parseReport(["runs/2026-08-17T09-09-03"])).toEqual({ runDir: resolve("runs/2026-08-17T09-09-03") });
  });

  it("refuses a report with no folder, and a flag a pass that grades nothing has no queue for", () => {
    expect(() => parseReport([])).toThrow(/needs the run folder/);
    expect(() => parseReport(["runs/x", "--jobs", "4"])).toThrow(/unexpected argument "--jobs"/);
  });

  const JUDGED_WITH_A_LIE: JudgeResult = {
    lines: [
      { line: LINE, source: "case", verdict: "pass", note: "three rows are listed" },
      { line: HONESTY_LINE, source: "case", verdict: "fail", note: "the balance is on no tool's answer" },
    ],
    degraded: false,
  };

  /** One saved run folder, written by the code that writes them, under a `runs`
   *  directory of its own — the real layout, so a path one keystroke short of it
   *  is a real path here too. `had` is the summary the run already wrote — as
   *  JSON rather than as a type, because what a saved summary holds is whatever
   *  it held on the day, and only what this pass reads back matters here. */
  const savedRun = async (results: readonly CaseResult[], had?: unknown): Promise<string> => {
    const runDir = join(await mkdtemp(join(tmpdir(), "genbench-report-")), "runs", "2026-01-01T00-00-00");
    await mkdir(runDir, { recursive: true });
    for (const result of results) {
      await writeCase(runDir, { outcome: undefined, html: undefined, shot: undefined, result });
    }
    if (had !== undefined) await writeFile(join(runDir, "summary.json"), JSON.stringify(had));
    return runDir;
  };

  it("rewrites the summary and the page off the saved verdicts, and touches nothing else", async () => {
    const was = scored(floorAt(true), JUDGED_WITH_A_LIE);
    const runDir = await savedRun([was]);
    const resultPath = join(runDir, was.contender, was.case, "result.json");
    const before = await readFile(resultPath, "utf8");

    expect(await report({ runDir })).toBe(0);

    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as RunSummary;
    // The split, said about a run that was graded before the split existed — and
    // not one judge call was spent saying it.
    expect(summary.run).toBe("2026-01-01T00-00-00");
    expect(summary.columns[was.contender]!.honesty).toEqual({ pass: 0, fail: 1, flipped: 0, unadjudicated: 0 });
    expect(summary.columns[was.contender]!.caseLines).toEqual({ pass: 1, fail: 0, na: 0 });
    expect(await readFile(join(runDir, "preview.html"), "utf8")).toContain(`<span>honesty</span><b>0/1</b>`);
    // The verdicts on disk are the evidence: a pass that edits its own input can
    // only be run once.
    expect(await readFile(resultPath, "utf8")).toBe(before);
  });

  /**
   * The floor's per-check split, backfilled — no model, no browser, no probe.
   *
   * `result.json` already carries what the split is read from: the verdicts, the
   * bindings under them and the check's own `why`. So a run graded before the
   * split existed can be re-rendered under it, which is the whole reason this
   * pass exists.
   */
  it("fills the floor's per-check split in for a run recorded before it existed", async () => {
    const dead: FloorResult = {
      delivered: true,
      renders: true,
      valid: false,
      blocking: ["the screen the agent saved would not compile"],
      wiredActions: {
        pass: false,
        pressed: 1,
        bindings: [{ where: "Cancel", effect: "none", why: "pressing it called nothing and changed nothing" }],
        why: "this case asks the screen to DO something, and no press ever asked the host for anything or opened a confirmation",
      },
      pass: false,
    };
    const runDir = await savedRun([scored(dead, JUDGED_WITH_A_LIE)]);

    expect(await report({ runDir })).toBe(0);

    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as RunSummary;
    expect(summary.columns["vendo-sonnet"]!.floorChecks).toEqual({
      delivered: { earned: 1, failed: 0, vacuous: 0 },
      renders: { earned: 1, failed: 0, vacuous: 0 },
      valid: { earned: 0, failed: 1, vacuous: 0 },
      pressed: { earned: 0, failed: 1, vacuous: 0 },
      // The press named no tool, so there was nothing on it to recognise.
      wired: { earned: 0, failed: 0, vacuous: 1 },
      // This case's stamps match no case in today's corpus, so the corpus cannot
      // say it asked — the check's own `why` can, since only an `action` case is
      // ever given one, and without that the split would stop adding up to the
      // failed `wiredActions` above it.
      actionProven: { earned: 0, failed: 1, vacuous: 0 },
    });
    // A compile crash and a dead button now read as two diseases on the page too.
    expect(await readFile(join(runDir, "preview.html"), "utf8")).toContain(`<th>actionProven</th>`);
  });

  /** Rewriting a page in place costs the page it replaces, so what this pass
   *  cannot work out for itself has to come off the summary already there: the
   *  disk's order is not the order the row was raced in, and a run holding
   *  another run's screens goes on saying whose they were. */
  it("keeps the column order and the provenance the folder already had", async () => {
    const runDir = await savedRun(
      [
        { ...scored(floorAt(true), JUDGED_WITH_A_LIE), contender: "vendo-sonnet" },
        { ...scored(floorAt(true), JUDGED_WITH_A_LIE), contender: "diy-claude" },
      ],
      // A row raced as `--contenders diy,vendo`: the opposite of the harness
      // order a report falls back to, so the disk cannot produce this by luck.
      { regradedFrom: "2025-12-31T00-00-00", columns: { "diy-claude": {}, "vendo-sonnet": {} } },
    );

    expect(await report({ runDir })).toBe(0);

    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")) as RunSummary;
    expect(Object.keys(summary.columns)).toEqual(["diy-claude", "vendo-sonnet"]);
    expect(summary.regradedFrom).toBe("2025-12-31T00-00-00");
  });

  /** `runs/` is one keystroke from `runs/<id>`, and read whole it is every run at
   *  once — added up as one, into a summary and a page dropped in `runs/` itself.
   *  A result names the folder it belongs in, so a folder that is not one run
   *  says so before anything is written. */
  it("refuses a path that is not one run folder, and leaves nothing behind there", async () => {
    const runDir = await savedRun([scored(floorAt(true), JUDGED_WITH_A_LIE)]);

    expect(await report({ runDir: dirname(runDir) })).toBe(1);

    expect(existsSync(join(dirname(runDir), "summary.json"))).toBe(false);
    expect(existsSync(join(dirname(runDir), "preview.html"))).toBe(false);
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
