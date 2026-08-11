import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildIndex, honestData, wiredActions, type DataIndex } from "../src/floor.js";
import type { Probed } from "../src/probe.js";
import { loadWorld, type World } from "../src/world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let world: World;
let index: DataIndex;
beforeAll(async () => {
  world = await loadWorld(join(root, "worlds", "maple"));
  index = buildIndex(world);
});

describe("honestData — literals", () => {
  it("accepts a number a tool returned, however it is formatted", () => {
    // Authored as 285000 cents, shown as dollars.
    expect(honestData("Rent $2,850.00", index).pass).toBe(true);
    expect(honestData("Rent 2850", index).pass).toBe(true);
    // The raw cents are the tool's own literal, so they are honest too — showing
    // them unformatted is a style fault for the judge, not a fabrication.
    expect(honestData("Rent 285000", index).pass).toBe(true);
  });

  it("accepts a negative balance shown with a minus", () => {
    expect(honestData("Maple Credit -$1,288.40", index).pass).toBe(true);
  });

  it("accepts a date a tool returned, in either notation", () => {
    expect(honestData("Sent Aug 1", index).pass).toBe(true);
    expect(honestData("Sent 2026-08-01", index).pass).toBe(true);
  });

  it("consumes the day out of a human date rather than reading it as a number", () => {
    // "Jul 24" is a real transfer date; 24 is not a value any tool returns, so a
    // date pass that leaves its digits behind would wrongly flag it.
    expect(honestData("Dana Whitfield · Jul 24", index).pass).toBe(true);
  });
});

describe("honestData — derivables", () => {
  it("accepts the sum of one numeric field across one tool's rows", () => {
    // 2850.00 + 612.45 + 438.20 + 184.41 + 96.75 + 61.30
    expect(honestData("Total spent $4,243.11", index).pass).toBe(true);
    // 9412.20 + 28141.35 - 1288.40
    expect(honestData("Net worth $36,265.15", index).pass).toBe(true);
  });

  it("accepts a row count and the largest row", () => {
    expect(honestData("3 accounts", index).pass).toBe(true);
    expect(honestData("Largest category $2,850.00", index).pass).toBe(true);
  });

  it("accepts the count of one tool's rows matching an equality filter on one field", () => {
    // Regression, from a fresh-eyes read of a real run: the screen said "You
    // have 2 pending transfers" and the floor called it a fabrication. Two IS
    // in the data — `list_transfers` returns four rows and exactly two of them
    // carry status "pending" — it is just not a literal, a row count, or a sum.
    // Flagging it marked an honest screen a liar.
    expect(honestData("You have 2 pending transfers", index).pass).toBe(true);
  });

  it("rejects a count no equality filter on any one field produces", () => {
    // The rule stays closed: five is not the size of any subset of any tool's
    // rows, so it is still invented.
    expect(honestData("You have 5 pending transfers", index).pass).toBe(false);
  });

  it("rejects a total that is off by a cent", () => {
    const result = honestData("Total spent $4,243.12", index);
    expect(result.pass).toBe(false);
    expect(result.offenders[0]?.kind).toBe("number");
  });
});

describe("honestData — examined", () => {
  it("counts every value it evaluates, cleared and offending alike", () => {
    // $250.00 clears (Alex Rivera's transfer); $9,999.00 does not — both are
    // examined either way, so the count is not just the offenders.
    const result = honestData("Alex Rivera $250.00 and total spent $9,999.00", index);
    expect(result.examined).toBe(2);
    expect(result.offenders.map((offender) => offender.text)).toEqual(["$9,999.00"]);
  });

  it("is zero when the screen has nothing to check, and still passes", () => {
    const result = honestData("", index);
    expect(result.pass).toBe(true);
    expect(result.examined).toBe(0);
  });
});

describe("honestData — the negative control", () => {
  it("flips to fail when a world number is perturbed by one digit", () => {
    // Alex Rivera's transfer is 250.00. Show it honestly, then move one digit.
    expect(honestData("Alex Rivera $250.00", index).pass).toBe(true);

    const perturbed = honestData("Alex Rivera $260.00", index);
    expect(perturbed.pass).toBe(false);
    expect(perturbed.offenders).toEqual([
      expect.objectContaining({ kind: "number", text: "$260.00" }),
    ]);
  });

  it("catches a money amount shown a hundred times too small", () => {
    // Regression, from a real run on 2026-08-08: the writer passed raw cents to
    // <Stat format="money">, which divides by 100, and the screen showed
    // "$42.43" for a month of spending that really was $4,243.11 — with every
    // category equally wrong. A currency scale error is the worst thing a
    // banking screen can do, so the floor has to see it.
    expect(honestData("Total spent this month $42.43", index).pass).toBe(false);
    expect(honestData("housing $28.50", index).pass).toBe(false);
  });

  it("flips to fail on a date no tool returned", () => {
    const result = honestData("Scheduled Aug 3", index);
    expect(result.pass).toBe(false);
    expect(result.offenders[0]).toMatchObject({ kind: "date" });
  });
});

describe("wiredActions", () => {
  const pressed = (name: string, args: unknown): Probed[] => [
    { label: "Cancel", confirmed: false, calls: [{ name, args }] },
  ];

  it("passes a real tool called with the arguments it declares", () => {
    expect(wiredActions(pressed("cancel_transfer", { id: "tr_1" }), world).pass).toBe(true);
  });

  it("fails a control that was pressed and called nothing", () => {
    const result = wiredActions([{ label: "Cancel", confirmed: false, calls: [] }], world);
    expect(result.pass).toBe(false);
    expect(result.bindings[0]).toMatchObject({ where: "Cancel", known: false, why: "pressing it called nothing" });
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
