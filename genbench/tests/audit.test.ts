/**
 * Tier 2 of the fabrication check: the values the deterministic pass could not
 * clear go to an auditor that may only write CODE, and only the harness running
 * that code can clear a value.
 *
 * Every test here mocks the model boundary and nothing else — the sandbox, the
 * anti-cheat and the comparison are the real ones, because they are the half
 * that decides a verdict.
 */
import { TOOL_NAME_PATTERN } from "@vendoai/core";
import { MockLanguageModelV3 } from "ai/test";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { audit, AUDITOR_CONTRACT, AUDITOR_PROMPT } from "../src/audit.js";
import { buildIndex, honestData, type DataIndex } from "../src/floor.js";
import { loadWorld, type World } from "../src/world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let world: World;
let index: DataIndex;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
  index = buildIndex(world);
});

// ------------------------------------------------------------------ fixtures

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

const replied = (programs: string[]) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ programs }) }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: ZERO_USAGE,
  warnings: [],
});

/** Every value the auditor was actually asked about, in the order it was asked
 *  — parsed back out of the assembled prompt, so a test answers the real batch
 *  rather than the batch it assumed. */
const asked = (call: { prompt: unknown }): string[] => {
  const parsed = JSON.parse(JSON.stringify(call.prompt)) as Array<{ content: unknown }>;
  const parts = parsed.flatMap((message) =>
    Array.isArray(message.content) ? (message.content as Array<{ type: string; text?: string }>) : [],
  );
  const listing = parts.filter((part) => part.type === "text").at(-1)?.text ?? "";
  return [...listing.matchAll(/^\d+\.\s+(.+)$/gm)].map((match) => match[1]!);
};

/** An auditor that answers whatever batch it is handed from a value -> program
 *  table, one table per round; the last round repeats. A value with no entry
 *  gets an empty program, which is the auditor saying it found no derivation. */
const proposing = (...rounds: Array<Readonly<Record<string, string>>>): MockLanguageModelV3 => {
  let round = 0;
  return new MockLanguageModelV3({
    doGenerate: async (call) => {
      const answers = rounds[Math.min(round++, rounds.length - 1)] ?? {};
      return replied(asked(call).map((value) => answers[value] ?? ""));
    },
  });
};

/** The share of this month's spending that housing is, rounded the way a screen
 *  showing one decimal place rounds it: 285000 of 424311 cents is 67.2%. The
 *  accessor is a parameter because the SAME arithmetic has to be writable
 *  against a tool whose name JavaScript cannot use as a variable. */
const shareVia = (spending: string): string =>
  `const rows = ${spending}.data;` +
  " const total = rows.reduce((sum, row) => sum + row.amount, 0);" +
  " return Math.round((rows[0].amount / total) * 1000) / 10;";

const HOUSING_SHARE = shareVia("data.get_spending");

const tier1For = (visibleText: string) => honestData(visibleText, index);

const auditing = async (visibleText: string, model: MockLanguageModelV3) =>
  await audit({ world, visibleText, tier1: tier1For(visibleText) }, { model });

// ------------------------------------------------ the case the floor got wrong

/**
 * The percentage edge, which is why tier 2 exists.
 *
 * "67.2% of total" is honest — housing is 285000 of 424311 cents, rounded the
 * way the screen rounded it — and the closed derivation allowlist has no rule
 * that reaches it, so tier 1 calls an honest screen a liar.
 */
describe("a legitimate operation the allowlist cannot express", () => {
  const SCREEN = "Housing $2,850.00 · 67.2% of total";

  it("is an offender under tier 1 alone", () => {
    const tier1 = tier1For(SCREEN);
    expect(tier1.pass).toBe(false);
    expect(tier1.offenders.map((offender) => offender.text)).toEqual(["67.2"]);
  });

  it("is cleared by a program the harness executed, and only by that", async () => {
    const result = await auditing(SCREEN, proposing({ "67.2": HOUSING_SHARE }));

    expect(result.pass).toBe(true);
    expect(result.offenders).toEqual([]);
    expect(result.audited).toEqual([
      { text: "67.2", program: HOUSING_SHARE, result: "67.2", verdict: "cleared-by-audit", attempts: 1 },
    ]);
  });

  it("is not cleared by a program that returns a different number", async () => {
    // The same shape rounded to a whole percent: 67, not the 67.2 on screen. A
    // screen must justify the figure it actually printed.
    const result = await auditing(
      SCREEN,
      proposing({
        "67.2":
          "const rows = data.get_spending.data;" +
          " const total = rows.reduce((sum, row) => sum + row.amount, 0);" +
          " return Math.round((rows[0].amount / total) * 100);",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.audited?.[0]).toMatchObject({ verdict: "offender", result: "67" });
  });
});

// --------------------------------------------------------- a fabricated number

describe("a number that is not in the data at all", () => {
  const SCREEN = "Total spent $9,999.00";

  it("stays an offender when the auditor can propose nothing", async () => {
    const result = await auditing(SCREEN, proposing({}));

    expect(result.pass).toBe(false);
    expect(result.offenders).toEqual([
      expect.objectContaining({ kind: "number", text: "$9,999.00", why: "no executable derivation found" }),
    ]);
    expect(result.audited?.[0]).toMatchObject({ verdict: "offender", attempts: 2 });
  });

  it("gives up after two attempts rather than asking forever", async () => {
    const model = proposing({});
    await auditing(SCREEN, model);
    expect(model.doGenerateCalls).toHaveLength(2);
  });
});

// ----------------------------------------------------------------- anti-cheat

/**
 * The one move that would make tier 2 worthless: writing the answer down.
 *
 * A program containing the value it is supposed to derive proves nothing — it
 * would clear a fabricated number as readily as an honest one — so it is
 * refused before it runs, at every scale the screen might have shown.
 */
describe("a program that echoes the value it is meant to derive", () => {
  const SCREEN = "Total spent $9,999.00";

  it("is rejected when the value is written as a literal", async () => {
    const result = await auditing(SCREEN, proposing({ "$9,999.00": "return 9999;" }));

    expect(result.pass).toBe(false);
    expect(result.audited?.[0]).toMatchObject({ verdict: "offender" });
    expect(result.audited?.[0]?.result).toContain("rejected");
  });

  it("is rejected at the other money scale, and in decimal form", async () => {
    // 999900 cents and 9999.00 dollars are the same claim as `return 9999`.
    const cents = await auditing(SCREEN, proposing({ "$9,999.00": "return 999900 / 100;" }));
    expect(cents.audited?.[0]).toMatchObject({ verdict: "offender" });
    expect(cents.audited?.[0]?.result).toContain("rejected");

    const decimal = await auditing(SCREEN, proposing({ "$9,999.00": "return 9999.00;" }));
    expect(decimal.audited?.[0]).toMatchObject({ verdict: "offender" });
  });

  it("counts a rejection as a spent attempt", async () => {
    const model = proposing({ "$9,999.00": "return 9999;" });
    const result = await auditing(SCREEN, model);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(result.audited?.[0]?.attempts).toBe(2);
  });

  it("still clears an honest program that happens to contain other numbers", async () => {
    // The guard is about THIS value, not about literals in general: a real
    // derivation is full of 0, 100 and 1000 and must not be refused for it.
    const result = await auditing("Housing 67.2% of total", proposing({ "67.2": HOUSING_SHARE }));
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------- sandbox discipline

/**
 * The programs are written by a model and executed by us, so the sandbox is a
 * security boundary, not a convenience.
 *
 * `import` is refused from the SOURCE rather than caught, because it is the one
 * construct that cannot be caught: a dynamic import inside `vm` throws
 * ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING from an internal callback, outside any
 * try/catch, and takes the whole benchmark run down with it. Proven on node 24
 * before this guard was written — supplying `importModuleDynamically` does not
 * help, it only changes which of the two errors kills the process.
 */
describe("the sandbox", () => {
  it("refuses reads, network, imports and runaway loops without taking the run down", async () => {
    const screen = "a 9001 b 9002 c 9003 d 9004";
    expect(tier1For(screen).offenders.map((offender) => offender.text)).toEqual(["9001", "9002", "9003", "9004"]);

    const result = await auditing(
      screen,
      proposing({
        "9001": 'return require("node:fs").readFileSync("/etc/passwd").length;',
        "9002": 'return import("node:fs");',
        "9003": 'return fetch("https://example.com");',
        "9004": "while (true) {} return 1;",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.audited).toHaveLength(4);
    for (const record of result.audited ?? []) expect(record.verdict).toBe("offender");

    const [read, imported, network, loop] = result.audited ?? [];
    expect(read?.result).toContain("require is not defined");
    expect(imported?.result).toContain("import");
    expect(network?.result).toContain("fetch is not defined");
    expect(loop?.result).toContain("timed out");
  });

  it("gives a program no globals beyond the tools' own data", async () => {
    const result = await auditing(
      "a 9001 b 9002",
      proposing({ "9001": "return process.pid;", "9002": "return globalThis.process === undefined ? 1 : 2;" }),
    );

    expect(result.audited?.[0]?.result).toContain("process is not defined");
    expect(result.audited?.[1]?.result).toBe("1");
  });

  it("refuses a program that tries to build code out of a string", async () => {
    // The escape hatch a sandboxed object graph always offers: reach a Function
    // constructor through a prototype and compile a new body. Code generation
    // is off, so it cannot.
    const result = await auditing(
      "a 9001",
      proposing({ "9001": 'return data.get_spending.constructor.constructor("return 1")();' }),
    );
    expect(result.audited?.[0]?.result).toContain("Code generation from strings disallowed");
  });
});

// ----------------------------------------------- names JavaScript cannot bind

/**
 * The shared tool contract permits names JavaScript cannot use as a variable —
 * a hyphen parses as subtraction, a leading digit is not an identifier, and a
 * keyword is reserved.
 *
 * Injecting one variable per tool put every such name in a destructuring
 * pattern, so `const { report-total } = ...` failed to PARSE — not the model's
 * program, the harness's own preamble, before a single character of the
 * derivation was read. Every honest value on a screen built from that tool
 * stayed a floor failure, and no program the auditor could possibly write would
 * have helped. Maple's tools are snake_case, which is the only reason this was
 * a landmine rather than a wrong number.
 */
describe("a tool whose name is not a JavaScript identifier", () => {
  const SCREEN = "Housing $2,850.00 · 67.2% of total";

  for (const name of ["report-total", "2fa-status", "class"]) {
    it(`clears the same honest value when the spending tool is named "${name}"`, async () => {
      // The real contract, not this test's opinion of it: these are names a
      // host may legally ship.
      expect(TOOL_NAME_PATTERN.test(name)).toBe(true);

      const renamed: World = {
        ...world,
        tools: world.tools.map((tool) =>
          tool.name === "get_spending" ? { ...tool, name, descriptor: { ...tool.descriptor, name } } : tool,
        ),
      };
      const program = shareVia(`data[${JSON.stringify(name)}]`);

      const result = await audit(
        { world: renamed, visibleText: SCREEN, tier1: honestData(SCREEN, buildIndex(renamed)) },
        { model: proposing({ "67.2": program }) },
      );

      expect(result.audited?.[0]).toMatchObject({ verdict: "cleared-by-audit", result: "67.2" });
      expect(result.pass).toBe(true);
    });
  }
});

// -------------------------------------------------------------------- degrade

/**
 * The auditor is a third party on someone else's infrastructure. When it cannot
 * be reached, the values it would have judged stay offenders and the check says
 * it is degraded — fail-closed, exactly as the judge does. It never throws: a
 * bad afternoon at the provider must not cost the run its case.
 */
describe("degrade", () => {
  const SCREEN = "Total spent $9,999.00";

  const throwing = (message: string): MockLanguageModelV3 =>
    new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error(message);
      },
    });

  it("keeps the offenders and marks the check degraded rather than crashing", async () => {
    const result = await auditing(SCREEN, throwing("503 Service Unavailable"));

    expect(result.degraded).toBe(true);
    expect(result.error).toContain("503");
    expect(result.pass).toBe(false);
    // Tier 1's own words stand: nothing executed, so "no executable derivation
    // found" would be a finding the harness never actually made.
    expect(result.offenders).toEqual(tier1For(SCREEN).offenders);
    expect(result.audited).toEqual([]);
  });

  /**
   * A provider request that never answers is the one failure the degrade path
   * above cannot catch, because the degrade path is never reached: `runOne`
   * writes the case only AFTER `auditFloor` returns, so an auditor that never
   * settles takes that case's screenshot, page and `result.json` with it and
   * the row never completes.
   *
   * The double never settles and never honours the signal, which is exactly
   * what an abort-only deadline cannot save us from.
   */
  it("gives up on a request that never answers, so the case is still written", async () => {
    const model = new MockLanguageModelV3({ doGenerate: () => new Promise(() => undefined) });

    const result = await audit({ world, visibleText: SCREEN, tier1: tier1For(SCREEN) }, { model, timeoutMs: 20 });

    expect(result.degraded).toBe(true);
    expect(result.error).toContain("did not answer within 20ms");
    expect(result.pass).toBe(false);
    // Fail-closed: nothing ran, so the values stay exactly the offenders tier 1
    // made them, in tier 1's own words.
    expect(result.offenders).toEqual(tier1For(SCREEN).offenders);
    expect(result.audited).toEqual([]);
  });

  it("is not degraded when a later attempt gets through", async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (request) => {
        call += 1;
        if (call === 1) throw new Error("429 Too Many Requests");
        return replied(asked(request).map(() => "return data.get_spending.data.length;"));
      },
    });

    const result = await auditing(SCREEN, model);

    expect(result.degraded).toBeUndefined();
    expect(result.audited?.[0]).toMatchObject({ verdict: "offender", result: "6" });
  });

  it("does not fail a value that cleared just because another did not", async () => {
    const result = await auditing("Housing 67.2% · Total $9,999.00", proposing({ "67.2": HOUSING_SHARE }));

    expect(result.pass).toBe(false);
    expect(result.audited?.map((record) => record.verdict)).toEqual(["cleared-by-audit", "offender"]);
    expect(result.offenders.map((offender) => offender.text)).toEqual(["$9,999.00"]);
  });
});

// ------------------------------------------------------------------ efficiency

/**
 * The common case is a screen tier 1 clears outright, and that case must cost
 * nothing. When there IS something to audit, the whole screen goes in one call.
 */
describe("what it costs", () => {
  it("calls nobody when the deterministic pass already cleared everything", async () => {
    const model = proposing({});
    const honest = "Housing $2,850.00 · Total $4,243.11";
    const tier1 = tier1For(honest);
    expect(tier1.pass).toBe(true);

    const result = await audit({ world, visibleText: honest, tier1 }, { model });

    expect(model.doGenerateCalls).toHaveLength(0);
    expect(result).toBe(tier1);
    expect(result.cost).toBeUndefined();
  });

  it("audits every unresolved value on a screen in ONE call, and shows the auditor the data", async () => {
    const model = proposing({});
    await auditing("a 9001 b 9002 c 9003", model);

    const sent = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    for (const value of ["9001", "9002", "9003"]) expect(sent).toContain(value);
    // It may SEE the data — that is what makes writing a derivation possible.
    expect(sent).toContain("get_spending");
    expect(sent).toContain("285000");
  });

  it("prices the auditor's own tokens through the auditor's own model", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        ...replied([""]),
        usage: {
          inputTokens: { total: 1_000_000, noCache: 1_000_000, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1_000_000, text: 1_000_000, reasoning: 0 },
        },
      }),
    });

    const result = await auditing("Total spent $9,999.00", model);

    // Two attempts at 1M in and 1M out, priced as claude-sonnet-5 ($2/$10).
    expect(result.cost?.usage).toMatchObject({ inputTokens: 2_000_000, outputTokens: 2_000_000, calls: 2 });
    expect(result.cost?.usd).toBeCloseTo(24, 6);
  });
});

// ------------------------------------------------------------------- contract

describe("AUDITOR_CONTRACT", () => {
  it("pins the auditor's own model, separately from whoever is being audited", () => {
    expect(AUDITOR_CONTRACT.model).toBe("claude-sonnet-5");
    expect(AUDITOR_CONTRACT.auditVersion).toBe(2);
  });

  it("hashes the prompt, so any edit to it changes the contract", () => {
    expect(AUDITOR_CONTRACT.promptHash).toBe(createHash("sha256").update(AUDITOR_PROMPT).digest("hex"));

    const edited = AUDITOR_PROMPT.replace("program", "PROGRAM");
    expect(edited).not.toBe(AUDITOR_PROMPT);
    expect(createHash("sha256").update(edited).digest("hex")).not.toBe(AUDITOR_CONTRACT.promptHash);
  });

  /**
   * The rule the whole tier rests on, quoted byte-exact: the auditor's prose
   * cannot clear anything, only executed code can. A softening of this sentence
   * turns the auditor from a prover into a second opinion, so it fails here
   * rather than being quietly re-signed by whoever edited it.
   */
  it("tells the auditor that its prose clears nothing", () => {
    expect(AUDITOR_PROMPT).toContain(
      "Only a program that runs and returns the value clears it. Your prose is never read.",
    );
  });
});
