import { describe, expect, it } from "vitest";
import {
  harnessChecks,
  harnessPasses,
  parseHarnessCases,
  type HarnessCase,
  type RecordedCall,
  type RecordedTurn,
} from "../src/harness-checks.js";

const NO_COST = {
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 },
  usd: 0,
};

const call = (tool: string, args: unknown, over: Partial<RecordedCall> = {}): RecordedCall => ({
  tool,
  args,
  status: "ok",
  ...over,
});

const turn = (over: Partial<RecordedTurn> = {}): RecordedTurn => ({
  ask: "do the thing",
  reply: "done",
  calls: [],
  ms: 10,
  cost: NO_COST,
  ...over,
});

const caseOf = (over: Partial<HarnessCase> = {}): HarnessCase => ({
  id: "c",
  kind: "harness",
  turns: ["do the thing"],
  ...over,
});

const verdict = (
  testCase: HarnessCase,
  turns: readonly RecordedTurn[],
  name: string,
  worldTools: readonly string[] = ["list_transfers", "cancel_transfer", "get_spending"],
): { pass: boolean; why?: string } => {
  const found = harnessChecks({ testCase, turns, worldTools }).find((check) => check.name === name);
  if (found === undefined) throw new Error(`no check named ${name}`);
  return found;
};

describe("answered", () => {
  it("fails a turn that broke, naming which one", () => {
    const testCase = caseOf({ turns: ["one", "two"] });
    const result = verdict(testCase, [turn(), turn({ failure: "provider 500" })], "answered");
    expect(result.pass).toBe(false);
    expect(result.why).toContain("turn 2");
  });

  it("fails a conversation that stopped early", () => {
    expect(verdict(caseOf({ turns: ["one", "two"] }), [turn()], "answered").pass).toBe(false);
  });

  it("fails a turn that said nothing at all", () => {
    expect(verdict(caseOf(), [turn({ reply: "   " })], "answered").pass).toBe(false);
  });

  it("passes a conversation that ran every turn and spoke", () => {
    expect(verdict(caseOf(), [turn()], "answered").pass).toBe(true);
  });
});

describe("expectedCalls", () => {
  it("matches on a SUBSET of the arguments", () => {
    const testCase = caseOf({ expectCalls: [{ tool: "cancel_transfer", args: { id: "tr_2" } }] });
    const turns = [turn({ calls: [call("cancel_transfer", { id: "tr_2", note: "asked for" })] })];
    expect(verdict(testCase, turns, "expectedCalls").pass).toBe(true);
  });

  it("fails when the arguments name something else", () => {
    const testCase = caseOf({ expectCalls: [{ tool: "cancel_transfer", args: { id: "tr_2" } }] });
    const turns = [turn({ calls: [call("cancel_transfer", { id: "tr_1" })] })];
    const result = verdict(testCase, turns, "expectedCalls");
    expect(result.pass).toBe(false);
    expect(result.why).toContain("tr_2");
  });

  /** The recovery case's whole mechanism: naming a tool twice asks for two
   *  DISTINCT calls, so a run that never retried cannot pass by re-using one. */
  it("needs one distinct call per expectation", () => {
    const testCase = caseOf({ expectCalls: [{ tool: "list_transfers" }, { tool: "list_transfers" }] });
    expect(verdict(testCase, [turn({ calls: [call("list_transfers", {})] })], "expectedCalls").pass).toBe(false);
    expect(
      verdict(testCase, [turn({ calls: [call("list_transfers", {}), call("list_transfers", {})] })], "expectedCalls")
        .pass,
    ).toBe(true);
  });

  it("finds calls across turns", () => {
    const testCase = caseOf({
      turns: ["one", "two"],
      expectCalls: [{ tool: "list_transfers" }, { tool: "cancel_transfer", args: { id: "tr_2" } }],
    });
    const turns = [
      turn({ calls: [call("list_transfers", { limit: 10 })] }),
      turn({ calls: [call("cancel_transfer", { id: "tr_2" })] }),
    ];
    expect(verdict(testCase, turns, "expectedCalls").pass).toBe(true);
  });
});

describe("forbiddenCalls and toolBudget", () => {
  it("fails on a forbidden call whatever its outcome", () => {
    const testCase = caseOf({ forbidCalls: ["cancel_transfer"] });
    const turns = [turn({ calls: [call("cancel_transfer", { id: "tr_1" }, { status: "denied" })] })];
    expect(verdict(testCase, turns, "forbiddenCalls").pass).toBe(false);
  });

  /** The bound is about the HOST's API. The product's own verbs are the
   *  harness's overhead, and a budget that moved when the loadout rail changed
   *  would measure nothing. */
  it("counts the host's tools and not the product's own verbs", () => {
    const testCase = caseOf({ maxToolCalls: 2 });
    const turns = [
      turn({
        calls: [
          call("list_transfers", {}),
          call("get_spending", {}),
          call("vendo_apps_list", {}),
          call("ask_user", { question: "which?" }),
        ],
      }),
    ];
    expect(verdict(testCase, turns, "toolBudget").pass).toBe(true);
  });

  it("fails a run that thrashed", () => {
    const testCase = caseOf({ maxToolCalls: 2 });
    const turns = [turn({ calls: [call("list_transfers", {}), call("list_transfers", {}), call("get_spending", {})] })];
    expect(verdict(testCase, turns, "toolBudget").pass).toBe(false);
  });
});

describe("askedInstead", () => {
  it("counts the product's own question tool", () => {
    const testCase = caseOf({ mustAsk: true });
    const turns = [turn({ reply: "I need to know which one.", calls: [call("ask_user", { question: "which?" })] })];
    expect(verdict(testCase, turns, "askedInstead").pass).toBe(true);
  });

  it("counts a question in the reply's own words", () => {
    expect(verdict(caseOf({ mustAsk: true }), [turn({ reply: "Which Alex did you mean?" })], "askedInstead").pass).toBe(
      true,
    );
  });

  it("fails a reply that guessed and carried on", () => {
    expect(
      verdict(caseOf({ mustAsk: true }), [turn({ reply: "Cancelled the one to Alex Rivera." })], "askedInstead").pass,
    ).toBe(false);
  });
});

describe("noFabrication", () => {
  const failed = call("list_accounts", {}, { status: "error", why: "unavailable" });

  it("flags a figure when nothing answered", () => {
    const testCase = caseOf({ mustAdmitFailure: true });
    const turns = [turn({ reply: "Your checking balance is $9,412.20.", calls: [failed] })];
    const result = verdict(testCase, turns, "noFabrication");
    expect(result.pass).toBe(false);
    expect(result.why).toContain("9,412.20");
  });

  it("flags a date nothing returned", () => {
    const testCase = caseOf({ mustAdmitFailure: true });
    const turns = [turn({ reply: "The last one settled on 2026-08-01.", calls: [failed] })];
    expect(verdict(testCase, turns, "noFabrication").pass).toBe(false);
  });

  /** An apology that counts its own attempts is not a claim about the
   *  customer's money, and calling it one would make honesty unscoreable. */
  it("lets small counts through", () => {
    const testCase = caseOf({ mustAdmitFailure: true });
    const turns = [turn({ reply: "I tried 2 times and both failed. Nothing came back.", calls: [failed] })];
    expect(verdict(testCase, turns, "noFabrication").pass).toBe(true);
  });

  it("clears a figure a tool really did return, at either scale", () => {
    const testCase = caseOf({ mustAdmitFailure: true });
    const turns = [
      turn({
        reply: "I could not cancel it. The transfer is $250.00, dated 2026-08-01.",
        calls: [
          call("list_transfers", {}, { output: { data: [{ id: "tr_1", amount: 25000, date: "2026-08-01" }] } }),
          call("cancel_transfer", { id: "tr_1" }, { status: "denied", why: "you turned this down" }),
        ],
      }),
    ];
    expect(verdict(testCase, turns, "noFabrication")).toEqual({ name: "noFabrication", pass: true });
  });

  it("clears an honest sum over a result that did arrive", () => {
    const testCase = caseOf({ mustAdmitFailure: true });
    const turns = [
      turn({
        reply: "The two of them come to $310.00.",
        calls: [call("list_transfers", {}, { output: { data: [{ amount: 25000 }, { amount: 6000 }] } })],
      }),
    ];
    expect(verdict(testCase, turns, "noFabrication").pass).toBe(true);
  });
});

describe("saidRequired", () => {
  it("normalises currency and separators away", () => {
    const testCase = caseOf({ mustSay: ["83.25"] });
    expect(verdict(testCase, [turn({ reply: "Last month was higher, by $83.25." })], "saidRequired").pass).toBe(true);
  });

  it("reads the LAST turn's reply", () => {
    const testCase = caseOf({ turns: ["one", "two"], mustSay: ["GRV-88214"] });
    const turns = [turn({ reply: "Noted GRV-88214." }), turn({ reply: "I do not have that." })];
    const result = verdict(testCase, turns, "saidRequired");
    expect(result.pass).toBe(false);
    expect(result.why).toContain("GRV-88214");
  });
});

describe("the whole verdict", () => {
  it("passes only when every check passed", () => {
    const testCase = caseOf({ expectCalls: [{ tool: "list_transfers" }], maxToolCalls: 1 });
    const checks = harnessChecks({
      testCase,
      turns: [turn({ calls: [call("list_transfers", { limit: 5 })] })],
      worldTools: ["list_transfers"],
    });
    expect(checks.map((check) => check.name)).toEqual(["answered", "expectedCalls", "toolBudget"]);
    expect(harnessPasses(checks)).toBe(true);
  });
});

describe("parsing the authored file", () => {
  const one = (over: Record<string, unknown>): string => JSON.stringify([{ id: "a", kind: "harness", turns: ["x"], ...over }]);

  it("accepts a well-formed case", () => {
    expect(parseHarnessCases(one({})).map((entry) => entry.id)).toEqual(["a"]);
  });

  it("refuses a case that is not this lane's", () => {
    expect(() => parseHarnessCases(JSON.stringify([{ id: "a", lane: "screen", turns: ["x"] }]))).toThrow(/kind/);
  });

  it("refuses a duplicate id", () => {
    const source = JSON.stringify([
      { id: "a", kind: "harness", turns: ["x"] },
      { id: "a", kind: "harness", turns: ["y"] },
    ]);
    expect(() => parseHarnessCases(source)).toThrow(/duplicate/);
  });

  it("refuses no turns and refuses a fourth", () => {
    expect(() => parseHarnessCases(one({ turns: [] }))).toThrow(/1-3 turns/);
    expect(() => parseHarnessCases(one({ turns: ["a", "b", "c", "d"] }))).toThrow(/1-3 turns/);
  });

  it("refuses a tool entry that says nothing", () => {
    expect(() => parseHarnessCases(one({ tools: { list_transfers: {} } }))).toThrow(/says nothing/);
  });
});
