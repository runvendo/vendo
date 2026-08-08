import type { UIPayload } from "@vendoai/core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { bindingsFromPayload, buildIndex, honestData, wiredActions, type DataIndex } from "./floor.js";
import { loadWorld, type World } from "./world.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let world: World;
let index: DataIndex;
beforeAll(async () => {
  world = await loadWorld(join(root, "world.json"));
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

  it("rejects a total that is off by a cent", () => {
    const result = honestData("Total spent $4,243.12", index);
    expect(result.pass).toBe(false);
    expect(result.offenders[0]?.kind).toBe("number");
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

describe("bindingsFromPayload", () => {
  const payload = {
    formatVersion: "vendo-genui/v2",
    root: "a",
    queries: [{ name: "transfers", tool: "list_transfers", input: { limit: 10 } }],
    nodes: [
      { id: "a", component: "Stack", children: ["b"] },
      { id: "b", component: "Button", props: { onPress: { action: "cancel_transfer", payload: { id: "tr_1" } } } },
    ],
  } as unknown as UIPayload;

  it("finds both the tree's queries and the nodes' action props", () => {
    expect(bindingsFromPayload(payload)).toEqual([
      { tool: "list_transfers", args: { limit: 10 }, where: "query transfers" },
      { tool: "cancel_transfer", args: { id: "tr_1" }, where: "node b" },
    ]);
  });

  it("ignores a host component's own fn reference, which names no tool", () => {
    const withFn = {
      formatVersion: "vendo-genui/v2",
      root: "a",
      nodes: [{ id: "a", component: "Card", props: { onPress: { action: "fn:refresh" } } }],
    } as unknown as UIPayload;
    expect(bindingsFromPayload(withFn)).toEqual([]);
  });
});

describe("wiredActions", () => {
  const at = (tool: string, args: unknown) => [{ tool, args, where: "node b" }];

  it("passes a real tool called with the arguments it declares", () => {
    expect(wiredActions(at("cancel_transfer", { id: "tr_1" }), world).pass).toBe(true);
  });

  it("fails a tool the world does not have", () => {
    const result = wiredActions(at("delete_account", { id: "x" }), world);
    expect(result.pass).toBe(false);
    expect(result.bindings[0]).toMatchObject({ known: false, why: 'no tool named "delete_account"' });
  });

  it("fails a missing required argument", () => {
    const result = wiredActions(at("cancel_transfer", {}), world);
    expect(result.pass).toBe(false);
    expect(result.bindings[0]).toMatchObject({ known: true, argsValid: false, why: 'missing required argument "id"' });
  });

  it("fails an argument the tool does not declare", () => {
    const result = wiredActions(at("cancel_transfer", { id: "tr_1", force: true }), world);
    expect(result.bindings[0]).toMatchObject({ argsValid: false, why: 'unknown argument "force"' });
  });

  it("fails an argument of the wrong type", () => {
    const result = wiredActions(at("list_transfers", { limit: "10" }), world);
    expect(result.bindings[0]).toMatchObject({ argsValid: false, why: 'argument "limit" should be a number' });
  });

  it("passes vacuously when a screen binds nothing", () => {
    expect(wiredActions([], world)).toEqual({ pass: true, bindings: [] });
  });
});
