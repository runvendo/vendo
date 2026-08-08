/**
 * Every contender for a case runs at once, so one column's crash or one
 * column's silence has to stay its own. `attempt` is where that is decided: it
 * turns a driver's exception and a driver's hang into ordinary results, which is
 * what lets the row be gathered with `Promise.all` — and so what keeps the
 * report's column order the contender order, whatever order they finish in.
 */
import { describe, expect, it } from "vitest";
import { WALL_CLOCK_MS } from "./claude-code.js";
import { attempt, CASE_TIMEOUT_MS, contenders, parseArgs } from "./run.js";

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
});
