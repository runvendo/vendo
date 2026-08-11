import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EXAMINE_CAP, honestData, wiredActions } from "../src/floor.js";
import type { Probed } from "../src/probe.js";
import { loadWorld, type World } from "../src/world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let world: World;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
});

/**
 * What `honestData` does with a screen now: it finds the numbers on it, and
 * decides nothing.
 *
 * The deterministic index and its closed derivation set — literals, sums, counts,
 * min, max, mean, filtered counts — are gone, so no rule clears a value here. A
 * number leaves this function unproven and is cleared by a program the auditor
 * wrote and the harness ran, or not at all; `audit.test.ts` owns those verdicts.
 */
describe("honestData — extraction", () => {
  it("hands over every number the screen printed, at any format or scale", () => {
    const result = honestData("Rent $2,850.00 · 2850 · 285000");
    expect(result.offenders.map((offender) => offender.text)).toEqual(["$2,850.00", "2850", "285000"]);
    // Nothing is cleared without an execution, so a screen with numbers on it
    // never passes on its own.
    expect(result.pass).toBe(false);
  });

  it("keeps a minus sign and a grouped number whole", () => {
    // Both are one value the auditor has to answer for, not several: a token cut
    // apart here is a question about a number no screen ever printed.
    expect(honestData("Maple Credit -$1,288.40").offenders.map((offender) => offender.text)).toEqual(["-$1,288.40"]);
    expect(honestData("Total spent $4,243.11").offenders.map((offender) => offender.text)).toEqual(["$4,243.11"]);
  });

  it("consumes a date rather than reading its digits as numbers", () => {
    // A date pass that left its digits behind would ask the auditor to derive
    // the 1 out of "Aug 1". Dates themselves are not graded — clearing a value
    // compares what a program returned to what is on screen, which is numeric.
    for (const screen of ["Sent Aug 1", "Sent 2026-08-01", "Dana Whitfield · Jul 24"]) {
      const result = honestData(screen);
      expect(result.examined).toBe(0);
      expect(result.pass).toBe(true);
    }
  });
});

describe("honestData — examined", () => {
  it("counts every number it hands to the auditor", () => {
    const result = honestData("Alex Rivera $250.00 and total spent $9,999.00");
    expect(result.examined).toBe(2);
    expect(result.offenders.map((offender) => offender.text)).toEqual(["$250.00", "$9,999.00"]);
  });

  it("is zero when the screen has nothing to check, and still passes", () => {
    const result = honestData("");
    expect(result.pass).toBe(true);
    expect(result.examined).toBe(0);
  });

  it("stops at the cap on a screen dense with numbers, and says so out loud", () => {
    // A number nobody examined is a number nobody checked, so the truncation is
    // announced rather than left to be inferred from a count.
    const said = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const result = honestData(Array.from({ length: EXAMINE_CAP + 5 }, (_, row) => `$${row + 100}.00`).join(" "));

      expect(result.examined).toBe(EXAMINE_CAP);
      expect(result.offenders).toHaveLength(EXAMINE_CAP);
      expect(said.mock.calls.flat().join(" ")).toContain(`auditing the first ${EXAMINE_CAP}`);
    } finally {
      said.mockRestore();
    }
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

  it("passes vacuously when a screen has nothing to press", () => {
    expect(wiredActions([], world)).toEqual({ pass: true, bindings: [] });
  });
});
