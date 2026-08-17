/**
 * The fabrication check: every number on the screen goes to an auditor that may
 * only write CODE, and only the harness running that code can clear a value.
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
import { audit, auditFloor, AUDITOR_CONTRACT, AUDITOR_PROMPT } from "../src/audit.js";
import { around, honestData, runFloor } from "../src/floor.js";
import { MAX_OUTPUT_TOKENS_FLOOR } from "../src/meter.js";
import { loadWorld, type World } from "../src/world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let world: World;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
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

const decided = (decisions: Array<{ claim: boolean; why: string }>) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ decisions }) }],
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

/** Housing's own amount, read out of the data and rescaled to the dollars the
 *  screen shows. Under the old deterministic tier this value was a literal and
 *  needed no program; now every number does. */
const HOUSING_AMOUNT = "return data.get_spending.data[0].amount / 100;";

/** A triage that waives whatever the table names — value -> its one clause — and
 *  calls every other token a claim, answering the batch it was really handed. */
const sorting = (waived: Readonly<Record<string, string>> = {}): MockLanguageModelV3 =>
  new MockLanguageModelV3({
    doGenerate: async (call) =>
      decided(
        asked(call).map((value) =>
          Object.hasOwn(waived, value)
            ? { claim: false, why: waived[value]! }
            : { claim: true, why: "a number the screen asserts about the data" },
        ),
      ),
  });

/** Every token the triage was asked about, WITH the surroundings quoted beside
 *  it. Parsed back out of the assembled prompt, because the surroundings are the
 *  only thing that can tell two occurrences of the same characters apart — a
 *  table keyed by text cannot express "this 9 and not that one". */
const askedInContext = (call: { prompt: unknown }): Array<{ value: string; where: string }> => {
  const parsed = JSON.parse(JSON.stringify(call.prompt)) as Array<{ content: unknown }>;
  const parts = parsed.flatMap((message) =>
    Array.isArray(message.content) ? (message.content as Array<{ type: string; text?: string }>) : [],
  );
  const listing = parts.filter((part) => part.type === "text").at(-1)?.text ?? "";
  return [...listing.matchAll(/^\d+\.\s+(.+)\n\s+where it appears: (.*)$/gm)].map((match) => ({
    value: match[1]!,
    where: match[2]!,
  }));
};

/** A triage that waives an occurrence by what SURROUNDS it — a phrase from the
 *  screen -> the one clause it is waived with. Everything it does not recognise
 *  is a claim. */
const sortingInContext = (waived: Readonly<Record<string, string>>): MockLanguageModelV3 =>
  new MockLanguageModelV3({
    doGenerate: async (call) =>
      decided(
        askedInContext(call).map(({ where }) => {
          const found = Object.entries(waived).find(([phrase]) => where.includes(phrase));
          return found === undefined
            ? { claim: true, why: "a number the screen asserts about the data" }
            : { claim: false, why: found[1]! };
        }),
      ),
  });

const extractedFrom = (visibleText: string) => honestData(visibleText, world);

const auditing = async (visibleText: string, model: MockLanguageModelV3) =>
  await audit({ world, visibleText, extracted: extractedFrom(visibleText) }, { model });

// ------------------------------------------------ the case the floor got wrong

/**
 * The percentage edge, which is why the auditor exists.
 *
 * "67.2% of total" is honest — housing is 285000 of 424311 cents, rounded the way
 * the screen rounded it — and no closed derivation set reaches it: sum, count,
 * min, max, mean and filtered count all miss, so the deterministic tier this
 * replaced called an honest screen a liar. Code reaches it.
 */
describe("a legitimate operation no closed allowlist can express", () => {
  const SCREEN = "Housing $2,850.00 · 67.2% of total";

  it("leaves extraction unproven, along with every other number on the screen", () => {
    const extracted = extractedFrom(SCREEN);
    expect(extracted.pass).toBe(false);
    expect(extracted.offenders.map((offender) => offender.text)).toEqual(["$2,850.00", "67.2"]);
  });

  it("is cleared by a program the harness executed, and only by that", async () => {
    const result = await auditing(SCREEN, proposing({ "$2,850.00": HOUSING_AMOUNT, "67.2": HOUSING_SHARE }));

    expect(result.pass).toBe(true);
    expect(result.offenders).toEqual([]);
    expect(result.examined).toBe(2);
    expect(result.audited).toEqual([
      { text: "$2,850.00", program: HOUSING_AMOUNT, result: "2850", verdict: "cleared-by-audit", attempts: 1 },
      { text: "67.2", program: HOUSING_SHARE, result: "67.2", verdict: "cleared-by-audit", attempts: 1 },
    ]);
  });

  /**
   * The same screen through the floor the run actually calls, end to end: real
   * extraction off the visible text, real execution, and `honestData` flipping the
   * whole floor to a pass. The percentage is the value that could not be cleared
   * before this contract; nothing about the check is stubbed but the model.
   */
  it("passes the floor's honesty check, so the floor itself passes", async () => {
    const shot = { png: Buffer.alloc(0), visibleText: SCREEN, dom: "", renders: true, consoleErrors: [] };
    const floor = runFloor({ world, artifact: "<Stack/>", blocking: [], trace: [], shot });
    expect(floor.honestData.pass).toBe(false);

    const audited = await auditFloor(floor, world, SCREEN, {
      triageModel: sorting(),
      model: proposing({ "$2,850.00": HOUSING_AMOUNT, "67.2": HOUSING_SHARE }),
    });

    expect(audited.honestData.pass).toBe(true);
    expect(audited.honestData.examined).toBe(2);
    expect(audited.honestData.audited).toHaveLength(2);
    expect(audited.pass).toBe(true);
  });

  it("is not cleared by a program that returns a different number", async () => {
    // The same shape rounded to a whole percent: 67, not the 67.2 on screen. A
    // screen must justify the figure it actually printed.
    const result = await auditing(
      SCREEN,
      proposing({
        "$2,850.00": HOUSING_AMOUNT,
        "67.2":
          "const rows = data.get_spending.data;" +
          " const total = rows.reduce((sum, row) => sum + row.amount, 0);" +
          " return Math.round((rows[0].amount / total) * 100);",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.offenders.map((offender) => offender.text)).toEqual(["67.2"]);
    expect(result.audited?.[1]).toMatchObject({ verdict: "offender", result: "67" });
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

  /**
   * The bare literal, which is the whole point of the guard, held against the two
   * relaxations below.
   *
   * A program that never mentions `data` computed nothing, whatever it hands
   * back, so a constant that happens to be common arithmetic buys no exemption
   * there — otherwise a screen showing 100 could be cleared by `return 100`.
   */
  it("still refuses a program that only writes the value down", async () => {
    const plain = await auditing("Total 2444", proposing({ "2444": "return 2444;" }));
    expect(plain.pass).toBe(false);
    expect(plain.audited?.[0]?.result).toContain("rejected");

    // The same, at a value that IS an arithmetic constant: `100` is exempt inside
    // a derivation and never on its own.
    const constant = await auditing("Score 100", proposing({ "100": "return 100;" }));
    expect(constant.pass).toBe(false);
    expect(constant.audited?.[0]?.result).toContain("rejected");
  });

  /**
   * The hole the allowlist WAS.
   *
   * Any literal in {0,1,2,3,10,12,24,60,100,365,1000,3600} was exempt from the
   * echo check as long as the program said the word `data` somewhere, so
   * `data; return 3` cleared a fabricated 3 on any screen that printed one — and
   * a 12, a 24, a 60 and a 100 with it. Those are not rare numbers on a screen;
   * they are the commonest ones. Every rule added to a list of exemptions is a
   * rule a fabrication can also satisfy, so the list is gone and an execution
   * decides instead: run the program again over data whose every number moved,
   * and an answer that did not move was never read off the data.
   */
  it("refuses a common constant a program merely mentioned `data` beside", async () => {
    for (const [screen, value] of [["Open jobs 3", "3"], ["Hours 24", "24"], ["Score 100", "100"]] as const) {
      const result = await auditing(screen, proposing({ [value]: `data; return ${value};` }));

      expect(result.pass, screen).toBe(false);
      expect(result.audited?.[0]?.result, screen).toContain("rejected: the program writes the value");
    }
  });

  /** The other half of the same rule, and the reason the allowlist existed: a
   *  real derivation is made of those constants, and it still clears. */
  it("still clears honest arithmetic built out of the same constants", async () => {
    const total =
      "const rows = data.get_spending.data;" +
      " return rows.reduce((sum, row) => sum + row.amount, 0) / 100;";
    const result = await auditing("Total spent $4,243.11", proposing({ "$4,243.11": total }));

    expect(result.audited?.[0]).toMatchObject({ verdict: "cleared-by-audit", result: "4243.11" });
    expect(result.pass).toBe(true);
  });

  /** The counterfactual is a MEASUREMENT, never the answer: what clears a value
   *  is what the program returned against the REAL data, and the moved run must
   *  not leak into the verdict's own number. */
  it("reports what the real data returned, never what the moved data did", async () => {
    const result = await auditing(
      "Housing $2,850.00",
      // `/ 100` is a literal that collides with $2,850.00 at no scale, so this
      // one is not even suspicious — and the recorded result is still the real
      // execution's, to the digit.
      proposing({ "$2,850.00": HOUSING_AMOUNT }),
    );

    expect(result.audited?.[0]).toMatchObject({ verdict: "cleared-by-audit", result: "2850" });
  });
});

/**
 * What is NOT the value written down — the two shapes the guard used to convict,
 * each of which made honest screens unprovable.
 *
 * The guard normalises every literal at both money scales, so a small value's
 * cent-scale form is a common arithmetic constant: a screen showing `1` percent
 * could never be proven, because the `* 100` in every honest share reads as 1's
 * own cent form. And a row selected by its id carries that id's digits into the
 * program, so a screen about job J-2444 had every value on it refused before a
 * single program ran (seen on the 2026-08-14 run of `open-jobs`).
 */
describe("what the anti-cheat must not convict", () => {
  it("clears a share derived with the * 100 every percentage needs", async () => {
    // Coffee is 6130 of 424311 cents — 1.44%, shown as the whole percent 1. The
    // literal 100 normalises onto 1 at the money scale, which is the collision.
    const result = await auditing(
      "Coffee 1% of spending",
      proposing({
        "1":
          "const rows = data.get_spending.data;" +
          " const total = rows.reduce((sum, row) => sum + row.amount, 0);" +
          " return Math.round((rows[5].amount / total) * 100);",
      }),
    );

    expect(result.audited?.[0]).toMatchObject({ verdict: "cleared-by-audit", result: "1" });
    expect(result.pass).toBe(true);
  });

  it("clears a derivation that reaches its row through an id literal", async () => {
    // $24.44 is job J-2444's quote, and the only way to read it is to name the
    // row: `"J-2444"` and `"2444"` are selectors, not the answer.
    const jobs: World = {
      ...world,
      tools: [
        ...world.tools,
        {
          name: "list_jobs",
          data: { data: [{ id: "J-2444", quoted: 2444 }, { id: "2444", quoted: 2444 }] },
          descriptor: { name: "list_jobs", description: "open jobs", inputSchema: { type: "object" }, risk: "read" },
        },
      ],
    };
    const SCREEN = "Job J-2444 · quoted $24.44";
    const shot = { png: Buffer.alloc(0), visibleText: SCREEN, dom: "", renders: true, consoleErrors: [] };

    const settled = await auditFloor(
      runFloor({ world: jobs, artifact: "<Stack/>", blocking: [], trace: [], shot }),
      jobs,
      SCREEN,
      {
        triageModel: sorting(),
        model: proposing({
          "$24.44": `return data.list_jobs.data.find((job) => job.id === "J-2444").quoted / 100;`,
        }),
      },
    );

    // The id itself never reached the auditor — the tools answer with those
    // exact characters — so the only question was the money.
    expect(settled.honestData.audited?.map((record) => record.verdict)).toEqual([
      "cleared-by-verbatim",
      "cleared-by-audit",
    ]);
    expect(settled.honestData.pass).toBe(true);
  });

  /**
   * The edge the string rule used to cost, and no longer does.
   *
   * A selector is exempt because it NAMES a row; a string holding nothing but
   * digits names a row and states a figure with the same characters, and no
   * reading of the SOURCE can tell those apart — `data; return Number("9999")`
   * is the same shape as an honest lookup. So this was refused, knowingly, to
   * keep the laundering shut.
   *
   * Running the program tells them apart where reading it cannot: the honest
   * lookup's answer moves when the row it read moves, and the laundered literal's
   * does not. The collision is no longer a cost anyone pays.
   */
  it("clears a bare-digit selector that collides with the value it selects", async () => {
    const jobs: World = {
      ...world,
      tools: [
        ...world.tools,
        {
          name: "list_jobs",
          data: { data: [{ id: "2444", quoted: 2444 }] },
          descriptor: { name: "list_jobs", description: "open jobs", inputSchema: { type: "object" }, risk: "read" },
        },
      ],
    };
    const SCREEN = "Job 2444 · quoted $24.44";

    // "2444" is the quote in cents as well as the row's name, so the SOURCE
    // cannot say which it is. The execution can: read the row and the answer
    // follows the row.
    const result = await audit(
      { world: jobs, visibleText: SCREEN, extracted: honestData(SCREEN, jobs) },
      { model: proposing({ "$24.44": `return data.list_jobs.data.find((job) => job.id === "2444").quoted / 100;` }) },
    );

    expect(result.audited?.[0]).toMatchObject({ verdict: "cleared-by-audit", result: "24.44" });
  });

  /** …and the fabrication that used to hide behind exactly those characters is
   *  still refused, because its answer does not follow anything. */
  it("still refuses the same digits when the program reads no row at all", async () => {
    const jobs: World = {
      ...world,
      tools: [
        ...world.tools,
        {
          name: "list_jobs",
          data: { data: [{ id: "2444", quoted: 2444 }] },
          descriptor: { name: "list_jobs", description: "open jobs", inputSchema: { type: "object" }, risk: "read" },
        },
      ],
    };
    const SCREEN = "Job 2444 · quoted $24.44";

    const result = await audit(
      { world: jobs, visibleText: SCREEN, extracted: honestData(SCREEN, jobs) },
      { model: proposing({ "$24.44": `data.list_jobs; return Number("2444") / 100;` }) },
    );

    expect(result.audited?.[0]).toMatchObject({ verdict: "offender" });
    expect(result.audited?.[0]?.result).toContain("rejected: the program writes the value");
  });
});

/**
 * Quotation marks are not a way out of the anti-cheat.
 *
 * Striking every string literal before the echo scan — which is what made row
 * selectors workable — left the cheat the whole tier exists to stop wide open:
 * `data; return Number("9999")` mentions `data`, reads nothing out of it, and
 * hands back a fabricated 9999 with the value hidden behind quotes. A string
 * holding nothing but the figure IS the figure.
 */
describe("a value written down inside a string", () => {
  const SCREEN = "Total spent $9,999.00";

  it("is rejected when the program launders it through Number()", async () => {
    const result = await auditing(SCREEN, proposing({ "$9,999.00": 'data; return Number("9999");' }));

    expect(result.pass).toBe(false);
    expect(result.audited?.[0]).toMatchObject({ verdict: "offender" });
    expect(result.audited?.[0]?.result).toContain("rejected: the program writes the value");
  });

  it("is rejected however the figure is punctuated inside the quotes", async () => {
    for (const written of ['"9,999.00"', '"$9,999.00"', "'999900'"]) {
      const result = await auditing(SCREEN, proposing({ "$9,999.00": `data; return Number(${written});` }));
      expect(result.audited?.[0], written).toMatchObject({ verdict: "offender" });
      expect(result.audited?.[0]?.result, written).toContain("rejected: the program writes the value");
    }
  });

  /** The rule is about strings that ARE the figure. A string with a letter in it
   *  names a row and still costs nothing, which is the whole reason literals are
   *  struck in the first place. */
  it("still clears a derivation that selects its row with a lettered id", async () => {
    const jobs: World = {
      ...world,
      tools: [
        ...world.tools,
        {
          name: "list_jobs",
          data: { data: [{ id: "J-2444", quoted: 999900 }] },
          descriptor: { name: "list_jobs", description: "open jobs", inputSchema: { type: "object" }, risk: "read" },
        },
      ],
    };

    const result = await audit(
      { world: jobs, visibleText: SCREEN, extracted: honestData(SCREEN, jobs) },
      {
        model: proposing({
          "$9,999.00": `return data.list_jobs.data.find((job) => job.id === "J-2444").quoted / 100;`,
        }),
      },
    );

    expect(result.audited?.[0]).toMatchObject({ verdict: "cleared-by-audit" });
    expect(result.pass).toBe(true);
  });

  /** And a string that is not a figure at all — a currency mark being stripped,
   *  a field name — is not an echo whatever the program computes. */
  it("still clears a computed value that passes through a non-numeric string", async () => {
    const jobs: World = {
      ...world,
      tools: [
        ...world.tools,
        {
          name: "list_jobs",
          data: { data: [{ id: "J-2444", quoted: "$999,900" }] },
          descriptor: { name: "list_jobs", description: "open jobs", inputSchema: { type: "object" }, risk: "read" },
        },
      ],
    };

    const result = await audit(
      { world: jobs, visibleText: SCREEN, extracted: honestData(SCREEN, jobs) },
      {
        model: proposing({
          "$9,999.00": `return Number(data.list_jobs.data[0].quoted.replace("$", "").replace(",", "")) / 100;`,
        }),
      },
    );

    expect(result.audited?.[0]).toMatchObject({ verdict: "cleared-by-audit" });
    expect(result.pass).toBe(true);
  });
});

/**
 * The screen's own formatting, handed back by the derivation.
 *
 * A program that computes the figure and returns it FORMATTED — `toFixed(2)`,
 * `toLocaleString()` — hands back a string, and the string rule wants the
 * screen's characters verbatim. So "2850.00" was convicted against a screen
 * showing "$2,850.00": the same money, refused on punctuation, three times on
 * the 2026-08-16 runs. A string that is nothing but a number IS that number and
 * is compared as one; only a genuinely textual answer reaches the verbatim rule.
 */
describe("a derivation that returns its number as text", () => {
  /** Housing's amount, computed in cents and handed back the way a screen prints
   *  it: the screen shows $2,850.00, the program returns "2850.00". */
  const FORMATTED = "return (data.get_spending.data[0].amount / 100).toFixed(2);";

  it("clears the value it computed, however that string is punctuated", async () => {
    const result = await auditing("Housing $2,850.00", proposing({ "$2,850.00": FORMATTED }));

    expect(result.audited?.[0]).toMatchObject({ verdict: "cleared-by-audit", result: "2850.00" });
    expect(result.pass).toBe(true);
  });

  /** Punctuation is the only thing forgiven: a formatted answer that states a
   *  different figure is refused, and the record quotes what it returned. */
  it("still convicts a formatted answer that is not the screen's figure", async () => {
    const result = await auditing("Housing $1,234.00", proposing({ "$1,234.00": FORMATTED }));

    expect(result.audited?.[0]).toMatchObject({ verdict: "offender" });
    expect(result.audited?.[0]?.result).toContain('returned "2850.00"');
    expect(result.pass).toBe(false);
  });

  /**
   * Where the two rules meet, and the reason a formatted answer is NOT rescaled.
   *
   * The numbers' comparison is scale-tolerant, because an amount held in cents is
   * honestly shown in dollars. Text is not: the data holds masks and ids as
   * strings, so reading "4471" off an account and calling it a dollars-and-cents
   * $44.71 would clear a fabricated balance with an account number. A formatted
   * answer states its own scale — that is what formatting IS — so it clears the
   * figure it states and no other.
   */
  it("does not let a mask the data holds clear a money claim it merely resembles", async () => {
    // Maple Checking's mask is "4471". None of these screens is that mask: one is
    // it a hundredfold off, the others are it printed as money.
    for (const shown of ["$44.71", "$4,471.00", "$4,471"]) {
      const result = await auditing(
        `Available ${shown}`,
        proposing({ [shown]: "return data.list_accounts.data[0].mask;" }),
      );

      expect(result.audited?.[0], shown).toMatchObject({ verdict: "offender" });
      expect(result.pass, shown).toBe(false);
    }
  });

  it("still demands the screen's own characters when the answer is genuinely text", async () => {
    const jobs: World = {
      ...world,
      tools: [
        ...world.tools,
        {
          name: "list_jobs",
          data: { data: [{ id: "J-2444" }] },
          descriptor: { name: "list_jobs", description: "open jobs", inputSchema: { type: "object" }, risk: "read" },
        },
      ],
    };
    const SCREEN = "Job J-9001";

    const result = await audit(
      { world: jobs, visibleText: SCREEN, extracted: honestData(SCREEN, jobs) },
      { model: proposing({ "J-9001": "return data.list_jobs.data[0].id;" }) },
    );

    expect(result.audited?.[0]).toMatchObject({ verdict: "offender" });
    expect(result.audited?.[0]?.result).toContain("which is not a number");
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
    expect(extractedFrom(screen).offenders.map((offender) => offender.text)).toEqual(["9001", "9002", "9003", "9004"]);

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
  // One value, because the subject is the name the program has to reach the data
  // through and nothing else.
  const SCREEN = "Housing 67.2% of total";

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
        { world: renamed, visibleText: SCREEN, extracted: honestData(SCREEN, renamed) },
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
 *
 * With no deterministic tier behind it, fail-closed now means EVERY number on the
 * screen stays an offender, which is the honest reading: nothing was proven.
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
    // The extraction's own words stand: nothing executed, so "no executable
    // derivation found" would be a finding the harness never actually made.
    expect(result.offenders).toEqual(extractedFrom(SCREEN).offenders);
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

    const result = await audit(
      { world, visibleText: SCREEN, extracted: extractedFrom(SCREEN) },
      { model, timeoutMs: 20 },
    );

    expect(result.degraded).toBe(true);
    expect(result.error).toContain("did not answer within 20ms");
    expect(result.pass).toBe(false);
    // Fail-closed: nothing ran, so every number the screen printed stays
    // unproven, in the extraction's own words.
    expect(result.offenders).toEqual(extractedFrom(SCREEN).offenders);
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
 * A screen with no numbers on it is the only screen that costs nothing, and every
 * other screen pays for exactly one call per attempt: the whole screen goes in
 * one batch, never one call per value.
 */
describe("what it costs", () => {
  it("calls nobody when the screen printed no numbers at all", async () => {
    const model = proposing({});
    const wordsOnly = "Accounts · Transfers · Spending";
    const extracted = extractedFrom(wordsOnly);
    expect(extracted.pass).toBe(true);

    const result = await audit({ world, visibleText: wordsOnly, extracted }, { model });

    expect(model.doGenerateCalls).toHaveLength(0);
    expect(result).toBe(extracted);
    expect(result.cost).toBeUndefined();
  });

  it("audits every number on a screen in ONE call, and shows the auditor the data", async () => {
    const model = proposing({});
    await auditing("a 9001 b 9002 c 9003", model);

    const sent = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    for (const value of ["9001", "9002", "9003"]) expect(sent).toContain(value);
    // It may SEE the data — that is what makes writing a derivation possible.
    expect(sent).toContain("get_spending");
    expect(sent).toContain("285000");
  });

  /** Contenders get an output ceiling through the meter; the auditor had none,
   *  so a truncated batch failed the length check and the whole screen degraded
   *  on our own default. */
  it("asks for the same output ceiling the contenders are given", async () => {
    const model = proposing({});
    await auditing("Total spent $9,999.00", model);

    expect(model.doGenerateCalls[0]!.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS_FLOOR);
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

// ------------------------------------------------------------ the three stages

/**
 * `auditFloor` is the run's one entry point, and it is where the three stages
 * meet: what the tools answer with verbatim, what a model waived and why, and
 * what a program the harness executed returned.
 *
 * The stages only ever REMOVE work from the next one, and only the last can
 * clear a number the screen computed. What each of them did is on the record —
 * a waiver nobody can read is a waiver nobody can overturn.
 */
describe("the honesty check, end to end", () => {
  const shotOf = (visibleText: string) => ({ png: Buffer.alloc(0), visibleText, dom: "", renders: true, consoleErrors: [] });
  const floorFor = (visibleText: string) =>
    runFloor({ world, artifact: "<Stack/>", blocking: [], trace: [], shot: shotOf(visibleText) });

  it("never asks the auditor about a token the triage waived, and keeps its reason", async () => {
    // "12" is the clock on a transfer row: no program can return it, and before
    // the triage it was a floor failure on every screen that showed a time.
    const SCREEN = "Sent 12:45 · Housing 67.2% of total";
    const auditor = proposing({ "67.2": HOUSING_SHARE });

    const settled = await auditFloor(floorFor(SCREEN), world, SCREEN, {
      triageModel: sorting({ "12": "the hour on a clock", "45": "the minutes on a clock" }),
      model: auditor,
    });

    // One call, and it carried only the claim.
    expect(auditor.doGenerateCalls).toHaveLength(1);
    expect(asked(auditor.doGenerateCalls[0]!)).toEqual(["67.2"]);
    expect(settled.honestData.pass).toBe(true);
    // The waived rows carry the surroundings their verdict was reached in; the
    // audited one does not, because one program answers for the value wherever
    // it appears.
    expect(settled.honestData.audited).toEqual([
      { text: "12", program: "", result: "the hour on a clock", verdict: "skipped-by-triage", attempts: 0, where: SCREEN },
      { text: "45", program: "", result: "the minutes on a clock", verdict: "skipped-by-triage", attempts: 0, where: SCREEN },
      { text: "67.2", program: HOUSING_SHARE, result: "67.2", verdict: "cleared-by-audit", attempts: 1 },
    ]);
    // …and the triage's whole answer is on the record, claims included, so a
    // reader can see what it was asked as well as what it let through.
    expect(settled.honestData.triage).toEqual([
      { text: "12", at: SCREEN.indexOf("12"), claim: false, why: "the hour on a clock", where: SCREEN },
      { text: "45", at: SCREEN.indexOf("45"), claim: false, why: "the minutes on a clock", where: SCREEN },
      {
        text: "67.2",
        at: SCREEN.indexOf("67.2"),
        claim: true,
        why: "a number the screen asserts about the data",
        where: SCREEN,
      },
    ]);
  });

  /** A waiver removes work; it can never clear a fabrication the auditor was
   *  asked about. The two verdicts stay independent. */
  it("still fails a claim the triage let through and no program could derive", async () => {
    const SCREEN = "Sent 12:45 · Total spent $9,999.00";

    const settled = await auditFloor(floorFor(SCREEN), world, SCREEN, {
      triageModel: sorting({ "12": "the hour on a clock", "45": "the minutes on a clock" }),
      model: proposing({}),
    });

    expect(settled.honestData.pass).toBe(false);
    expect(settled.honestData.offenders.map((offender) => offender.text)).toEqual(["$9,999.00"]);
    expect(settled.pass).toBe(false);
  });

  /**
   * The waiver is about ONE occurrence, never about the characters.
   *
   * The tokens were deduplicated by text before the triage saw them, so a screen
   * showing a clock and a count that happen to share a digit got ONE verdict for
   * both: waiving the `9` in "9:15 AM" waived the `9` in "Total count 9" with it,
   * and a fabricated count was cleared by a sentence about a clock. The two are
   * sorted separately now, each quoted where it actually sits.
   */
  it("waives the clock nine without waiving the counted nine", async () => {
    // Far enough apart that neither nine falls inside the other's context window
    // — the windows are what the triage is judging, so a test that let them
    // overlap would prove nothing about telling the two apart.
    const SCREEN =
      "Standup at 9:15 AM in the back room off the side hallway, and the printed agenda is pinned " +
      "to the corkboard by the door for anyone who wants to read it before we begin. Total count 9";
    const clock = SCREEN.indexOf("9");
    const count = SCREEN.lastIndexOf("9");
    const auditor = proposing({});

    const settled = await auditFloor(floorFor(SCREEN), world, SCREEN, {
      triageModel: sortingInContext({ "Standup at": "a time on a clock" }),
      model: auditor,
    });

    // The counted nine reached the auditor on its own, and no program cleared it.
    expect(auditor.doGenerateCalls.length).toBeGreaterThan(0);
    expect(asked(auditor.doGenerateCalls[0]!)).toEqual(["9"]);
    expect(settled.honestData.pass).toBe(false);
    expect(settled.honestData.offenders).toEqual([
      { kind: "number", text: "9", at: count, why: "no executable derivation found" },
    ]);

    // Two verdicts about the same characters, each carrying the surroundings it
    // was reached in, so a reader can tell which nine was let go.
    expect(settled.honestData.triage).toEqual([
      { text: "9", at: clock, claim: false, why: "a time on a clock", where: around(SCREEN, "9", clock) },
      { text: "15", at: SCREEN.indexOf("15"), claim: false, why: "a time on a clock", where: around(SCREEN, "15") },
      {
        text: "9",
        at: count,
        claim: true,
        why: "a number the screen asserts about the data",
        where: around(SCREEN, "9", count),
      },
    ]);
    expect(settled.honestData.triage?.[0]?.where).not.toBe(settled.honestData.triage?.[2]?.where);
  });

  /** Fail-closed: a triage that cannot be reached waives nothing, which is
   *  exactly what this check did before it existed, and it says so. */
  it("checks every token when the triage cannot be reached, and marks the check degraded", async () => {
    const SCREEN = "Sent 12:45 · Housing 67.2% of total";
    const auditor = proposing({ "67.2": HOUSING_SHARE });

    const settled = await auditFloor(floorFor(SCREEN), world, SCREEN, {
      triageModel: new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("503 Service Unavailable");
        },
      }),
      model: auditor,
    });

    expect(asked(auditor.doGenerateCalls[0]!)).toEqual(["12", "45", "67.2"]);
    expect(settled.honestData.degraded).toBe(true);
    expect(settled.honestData.error).toContain("503");
    expect(settled.honestData.pass).toBe(false);
    expect(settled.honestData.offenders.map((offender) => offender.text)).toEqual(["12", "45"]);
  });

  it("spends nothing at all on a screen whose numbers the tools already answer with", async () => {
    const triageModel = sorting();
    const auditor = proposing({});
    const SCREEN = "Maple Checking ···· 4471";

    const settled = await auditFloor(floorFor(SCREEN), world, SCREEN, { triageModel, model: auditor });

    expect(triageModel.doGenerateCalls).toHaveLength(0);
    expect(auditor.doGenerateCalls).toHaveLength(0);
    expect(settled.honestData.pass).toBe(true);
    expect(settled.honestData.cost).toBeUndefined();
  });

  /** The triage and the auditor are pinned to the same model, so the screen's
   *  whole honesty bill is one figure priced once — and it is the benchmark's
   *  overhead, never a contender's. */
  it("prices the triage's tokens beside the auditor's, through the one model both are pinned to", async () => {
    const SCREEN = "Sent 12:45 · Total spent $9,999.00";
    const million = {
      inputTokens: { total: 1_000_000, noCache: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1_000_000, text: 1_000_000, reasoning: 0 },
    };

    const settled = await auditFloor(floorFor(SCREEN), world, SCREEN, {
      triageModel: new MockLanguageModelV3({
        doGenerate: async (call) => ({
          ...decided(asked(call).map(() => ({ claim: true, why: "a number the screen asserts about the data" }))),
          usage: million,
        }),
      }),
      model: new MockLanguageModelV3({ doGenerate: async () => ({ ...replied(["", "", ""]), usage: million }) }),
    });

    // One triage call and two auditor attempts, at 1M in and 1M out each,
    // priced as claude-sonnet-5 ($2/$10).
    expect(settled.honestData.cost?.usage).toMatchObject({ calls: 3, inputTokens: 3_000_000, outputTokens: 3_000_000 });
    expect(settled.honestData.cost?.usd).toBeCloseTo(36, 6);
  });
});

// ------------------------------------------------------------------- contract

describe("AUDITOR_CONTRACT", () => {
  it("pins the auditor's own model, separately from whoever is being audited", () => {
    expect(AUDITOR_CONTRACT.model).toBe("claude-sonnet-5");
    expect(AUDITOR_CONTRACT.auditVersion).toBe(8);
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
