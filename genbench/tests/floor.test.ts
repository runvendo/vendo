import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { checks, EXAMINE_CAP, honestData, passes, wiredActions, type FloorResult } from "../src/floor.js";
import type { Probed } from "../src/probe.js";
import { loadWorld, type World } from "../src/world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let world: World;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
});

/**
 * What `honestData` does with a screen: it finds the numbers on it, clears the
 * ones the tools answer with in those exact characters, and decides nothing else.
 *
 * The deterministic index and its closed derivation set — literals, sums, counts,
 * min, max, mean, filtered counts — are gone, so no RULE clears a value here.
 * What is left is not a rule but an identity: the token IS a string the data
 * holds. Everything else leaves this function unproven, for the triage to sort
 * and the auditor to answer for; `audit.test.ts` owns those verdicts.
 */
describe("honestData — extraction", () => {
  it("hands over every number the screen printed, at any format or scale", () => {
    const result = honestData("Rent $2,850.00 · 2850 · 285000", world);
    expect(result.offenders.map((offender) => offender.text)).toEqual(["$2,850.00", "2850", "285000"]);
    // Nothing is cleared without an execution, so a screen with numbers on it
    // never passes on its own.
    expect(result.pass).toBe(false);
  });

  it("keeps a minus sign and a grouped number whole", () => {
    // Both are one value the auditor has to answer for, not several: a token cut
    // apart here is a question about a number no screen ever printed.
    expect(honestData("Maple Credit -$1,288.40", world).offenders.map((offender) => offender.text)).toEqual([
      "-$1,288.40",
    ]);
    expect(honestData("Total spent $4,243.11", world).offenders.map((offender) => offender.text)).toEqual([
      "$4,243.11",
    ]);
  });

  /**
   * The token a hyphenated id used to be cut into.
   *
   * `J-2444` read as a number is `-2444`: a negative nobody printed. No honest
   * program returns it, and the anti-cheat then refused every program that
   * selected the row by its own id — so a screen about job J-2444 could not have
   * a single value on it proven. It is one token with its prefix, which is also
   * what lets the tools' own text clear it.
   */
  it("keeps a hyphenated identifier whole instead of reading it as a negative number", () => {
    const asked = honestData("Job J-2444 · INV-0961 · 6 open", world).offenders.map((offender) => offender.text);

    expect(asked).toEqual(["J-2444", "INV-0961", "6"]);
    expect(asked).not.toContain("-2444");
  });

  it("consumes a date rather than reading its digits as numbers", () => {
    // A date pass that left its digits behind would ask the auditor to derive
    // the 1 out of "Aug 1". Dates themselves are not graded — clearing a value
    // compares what a program returned to what is on screen, which is numeric.
    for (const screen of ["Sent Aug 1", "Sent 2026-08-01", "Dana Whitfield · Jul 24"]) {
      const result = honestData(screen, world);
      expect(result.examined).toBe(0);
      expect(result.pass).toBe(true);
    }
  });
});

/**
 * The one clearing that needs no model and cannot be gamed: the screen printed
 * the characters a tool answers with.
 *
 * Maple's accounts carry `mask: "4471"` as TEXT, so a screen showing 4471 is
 * quoting the data, not deriving anything from it. There is nothing for a model
 * to decide and nothing for a program to compute, and paying two calls to reach
 * that conclusion is how an honest screen ends up degraded by a provider outage.
 */
describe("honestData — cleared verbatim", () => {
  it("clears a token the tools answer with, character for character, without a call", () => {
    const result = honestData("Maple Checking ···· 4471", world);

    expect(result.pass).toBe(true);
    expect(result.offenders).toEqual([]);
    expect(result.examined).toBe(1);
    expect(result.audited).toEqual([
      { text: "4471", program: "", result: "the tool data answers with this exact text", verdict: "cleared-by-verbatim", attempts: 0 },
    ]);
  });

  it("leaves a number the data holds as a NUMBER for the auditor", () => {
    // 941220 is the checking balance, held as a number and shown at either money
    // scale. Rescaling is arithmetic, and arithmetic is the auditor's.
    const result = honestData("Balance 941220", world);

    expect(result.pass).toBe(false);
    expect(result.offenders.map((offender) => offender.text)).toEqual(["941220"]);
    expect(result.audited).toBeUndefined();
  });

  it("clears a hyphenated id the tools really answer with, and convicts one they do not", () => {
    const jobs: World = {
      ...world,
      tools: [
        ...world.tools,
        {
          name: "list_jobs",
          data: { data: [{ id: "J-2444", quoted: 1_320_000 }] },
          descriptor: { name: "list_jobs", description: "jobs", inputSchema: { type: "object" }, risk: "read" },
        },
      ],
    };
    const result = honestData("Job J-2444 · Job J-9999", jobs);

    expect(result.audited?.map((record) => record.text)).toEqual(["J-2444"]);
    expect(result.offenders.map((offender) => offender.text)).toEqual(["J-9999"]);
  });

  it("asks about a repeated value once, however many times the screen printed it", () => {
    const result = honestData("···· 4471 · Maple Checking ···· 4471", world);

    expect(result.examined).toBe(2);
    expect(result.audited).toHaveLength(1);
    expect(result.pass).toBe(true);
  });
});

describe("honestData — examined", () => {
  it("counts every number it hands to the auditor", () => {
    const result = honestData("Alex Rivera $250.00 and total spent $9,999.00", world);
    expect(result.examined).toBe(2);
    expect(result.offenders.map((offender) => offender.text)).toEqual(["$250.00", "$9,999.00"]);
  });

  it("is zero when the screen has nothing to check, and still passes", () => {
    const result = honestData("", world);
    expect(result.pass).toBe(true);
    expect(result.examined).toBe(0);
  });

  /**
   * The cap, and where it now says so.
   *
   * A number nobody examined is a number nobody checked. That used to be one
   * line on stdout — gone the moment the terminal scrolled, while the pass it
   * hid outlived it in `result.json`, where nothing distinguished "twenty values
   * cleared" from "twenty of ninety cleared". The count rides on the result.
   */
  it("stops at the cap on a screen dense with numbers, and records how many it left", () => {
    const result = honestData(
      Array.from({ length: EXAMINE_CAP + 5 }, (_, row) => `$${row + 100}.00`).join(" "),
      world,
    );

    expect(result.examined).toBe(EXAMINE_CAP);
    expect(result.found).toBe(EXAMINE_CAP + 5);
    expect(result.offenders).toHaveLength(EXAMINE_CAP);
  });

  it("finds exactly what it examined on a screen the cap never reached", () => {
    const result = honestData("Alex Rivera $250.00 and total spent $9,999.00", world);
    expect(result).toMatchObject({ examined: 2, found: 2 });
  });
});

/**
 * A pass is not always a pass, and the score has to know the difference.
 *
 * `checks` handed out bare booleans, and `shapeTable` added them up — so a blank
 * page, with no numbers to check and nothing to press, scored 5/5 in the only
 * aggregate this benchmark has, while the preview beside it was already muting
 * both of those cells as unearned. And a check our own triage or auditor could
 * not be reached for read as the contender fabricating data.
 */
describe("checks", () => {
  const floorWith = (over: Partial<FloorResult>): FloorResult => ({
    delivered: true,
    renders: true,
    valid: true,
    blocking: [],
    honestData: { pass: true, offenders: [], examined: 4, found: 4 },
    wiredActions: { pass: true, pressed: 2, bindings: [] },
    pass: true,
    ...over,
  });

  const named = (floor: FloorResult, name: string): { pass: boolean; vacuous?: true; degraded?: true } =>
    checks(floor).find((check) => check.name === name)!;

  it("calls a screen with nothing to check and nothing to press vacuous, not passed", () => {
    const blank = floorWith({
      honestData: { pass: true, offenders: [], examined: 0, found: 0 },
      wiredActions: { pass: true, pressed: 0, bindings: [] },
    });

    expect(named(blank, "honestData")).toEqual({ name: "honestData", pass: true, vacuous: true });
    expect(named(blank, "wiredActions")).toEqual({ name: "wiredActions", pass: true, vacuous: true });
    // The three that are always in front of a screen stay plain passes.
    expect(named(blank, "renders")).toEqual({ name: "renders", pass: true });
  });

  it("calls a screen that really was examined a plain pass", () => {
    expect(named(floorWith({}), "honestData")).toEqual({ name: "honestData", pass: true });
    expect(named(floorWith({}), "wiredActions")).toEqual({ name: "wiredActions", pass: true });
  });

  it("calls an unreachable honesty check degraded rather than a fabrication", () => {
    const degraded = floorWith({
      honestData: {
        pass: false,
        offenders: [{ kind: "number", text: "$9,999.00", at: 0, why: "no executable derivation cleared it" }],
        examined: 1,
        found: 1,
        degraded: true,
        error: "529 overloaded",
      },
    });

    expect(named(degraded, "honestData")).toMatchObject({ degraded: true });
    // …and it does not fail the floor, for the reason a degraded judge does not
    // fail the run: an outage in our machinery is never the contender's fault.
    expect(passes(degraded)).toBe(true);
  });

  it("still fails a screen whose honesty check ran and found a fabrication", () => {
    expect(
      passes(
        floorWith({
          honestData: {
            pass: false,
            offenders: [{ kind: "number", text: "$9,999.00", at: 0, why: "no executable derivation found" }],
            examined: 1,
            found: 1,
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("wiredActions", () => {
  const pressed = (name: string, args: unknown): Probed[] => [
    { label: "Cancel", confirmed: false, changed: false, calls: [{ name, args }] },
  ];

  it("passes a real tool called with the arguments it declares", () => {
    expect(wiredActions(pressed("cancel_transfer", { id: "tr_1" }), world).pass).toBe(true);
  });

  /**
   * The two halves of a press that asked the host for nothing.
   *
   * An interactive screen is expected to have controls that only move local
   * state — a dialog, a tab, a dismiss — so "it called nothing" is not a verdict
   * on its own. What separates a live one from a dead one is whether the screen
   * moved, and that is the only thing these two cases differ by.
   */
  it("passes a control that called nothing but visibly changed the screen", () => {
    const result = wiredActions([{ label: "Details", confirmed: false, changed: true, calls: [] }], world);
    expect(result.pass).toBe(true);
    expect(result.bindings[0]).toEqual({
      where: "Details",
      effect: "state",
      why: "changed the screen without calling a tool",
    });
  });

  it("fails a control that called nothing and changed nothing", () => {
    const result = wiredActions([{ label: "Cancel", confirmed: false, changed: false, calls: [] }], world);
    expect(result.pass).toBe(false);
    expect(result.bindings[0]).toEqual({
      where: "Cancel",
      effect: "none",
      why: "pressing it called nothing and changed nothing",
    });
  });

  /** The one press that changed the screen and is dead anyway. A confirmation
   *  authorizes an action, and the probe only follows through on the primary one,
   *  so being told yes and asking for nothing is not local state — it is a screen
   *  that asks "are you sure?" and means nothing by it. */
  it("fails a confirmation that was followed through and still called nothing", () => {
    const result = wiredActions([{ label: "Cancel transfer", confirmed: true, changed: true, calls: [] }], world);
    expect(result.pass).toBe(false);
    expect(result.bindings[0]).toEqual({
      where: "Cancel transfer",
      effect: "none",
      why: "a confirmation was followed through and it still called nothing",
    });
  });

  /** …and the control that closes one. Nothing is left visible for the probe to
   *  confirm, so a dismiss records `confirmed: false` and is graded like any other
   *  local control — the rule above cannot reach it. */
  it("passes a dismiss that closes a dialog and calls nothing", () => {
    const result = wiredActions([{ label: "Keep it", confirmed: false, changed: true, calls: [] }], world);
    expect(result.pass).toBe(true);
    expect(result.bindings[0]).toMatchObject({ effect: "state" });
  });

  it("fails a tool the world does not have", () => {
    const result = wiredActions(pressed("delete_account", { id: "x" }), world);
    expect(result.pass).toBe(false);
    expect(result.bindings[0]).toMatchObject({ known: false, why: 'no tool named "delete_account"' });
  });

  it("fails a missing required argument", () => {
    const result = wiredActions(pressed("cancel_transfer", {}), world);
    expect(result.pass).toBe(false);
    expect(result.bindings[0]).toMatchObject({ known: true, argsValid: false, why: 'missing required argument "id"' });
  });

  it("fails an argument the tool does not declare", () => {
    const result = wiredActions(pressed("cancel_transfer", { id: "tr_1", force: true }), world);
    expect(result.bindings[0]).toMatchObject({ argsValid: false, why: 'unknown argument "force"' });
  });

  it("fails an argument of the wrong type", () => {
    const result = wiredActions(pressed("list_transfers", { limit: "10" }), world);
    expect(result.bindings[0]).toMatchObject({ argsValid: false, why: 'argument "limit" should be a number' });
  });

  /** …and says so. A screen with no controls passes without one control having
   *  been proven live, so the count is what tells that apart from a screen whose
   *  controls all held — exactly what `honestData.examined` does for numbers. */
  it("passes vacuously when a screen has nothing to press, and counts nothing pressed", () => {
    expect(wiredActions([], world)).toEqual({ pass: true, pressed: 0, bindings: [] });
  });

  it("does not pass vacuously when the case was an action", () => {
    expect(wiredActions([], world, ["action"]).pass).toBe(false);
  });

  /**
   * An `action` case asks the screen to DO something, and the only evidence that
   * it did is a tool call. A screen that opens a confirmation, moves a toggle and
   * never asks the host for anything passed this check — every press held, and
   * the case it was answering was never done.
   */
  describe("an action case", () => {
    const DETAILS: Probed[] = [{ label: "Details", confirmed: false, changed: true, calls: [] }];

    it("is not proven by controls that only moved the screen", () => {
      const result = wiredActions(DETAILS, world, ["action"]);
      expect(result.pass).toBe(false);
      expect(result.why).toContain("no press ever asked the host for anything");
      // Every binding still holds on its own — the failure is the case's, and it
      // has to say so somewhere a reader can find it.
      expect(result.bindings[0]).toMatchObject({ effect: "state" });
    });

    it("is proven by one press that called a real tool with valid arguments", () => {
      const result = wiredActions(pressed("cancel_transfer", { id: "tr_1" }), world, ["action"]);
      expect(result.pass).toBe(true);
      expect(result.why).toBeUndefined();
    });

    it("is not proven by a tool call that does not hold", () => {
      expect(wiredActions(pressed("cancel_transfer", {}), world, ["action"]).pass).toBe(false);
    });

    it("leaves a display case exactly where it was", () => {
      expect(wiredActions(DETAILS, world, ["display"]).pass).toBe(true);
      expect(wiredActions(DETAILS, world).pass).toBe(true);
    });
  });

  it("counts the controls the probe pressed, not the calls they made", () => {
    // One press that fires two tools is two bindings and one control; a press
    // that fires nothing is still a control that was pressed.
    const trace: Probed[] = [
      { label: "Refresh", confirmed: false, changed: true, calls: [{ name: "list_transfers", args: { limit: 5 } }, { name: "get_spending", args: {} }] },
      { label: "Details", confirmed: false, changed: true, calls: [] },
    ];

    expect(wiredActions(trace, world).pressed).toBe(2);
    expect(wiredActions(trace, world).bindings).toHaveLength(3);
  });
});
