/**
 * The turn's own lesson, through the REAL seam: the guard-bound registry writes
 * the outcome, `turn.tools.call` reads it back, and what the assertions look at is
 * the `ToolResult` a harness hands its model verbatim. No stub on either side —
 * a ledger tested against a fake result proves only that the fake is empty.
 */
import { describe, expect, it } from "vitest";
import { createTurnTools } from "../src/turn-tools.js";
import { boundRegistry, ctx, readTool, testGuard, type TestTool } from "../src/test-doubles.test-util.js";

function turnTools(tools: Record<string, TestTool>) {
  const guard = testGuard();
  const registry = boundRegistry(tools, guard);
  return {
    registry,
    tools: createTurnTools({ registry, guard, ctx: ctx(), interactive: true, mirror: () => {} }),
  };
}

/** A read whose catalog is genuinely empty for every query. */
const emptySearch: TestTool = {
  descriptor: readTool("search_catalog"),
  execute: () => ({ components: [] }),
};

const alwaysFails = (name: string): TestTool => ({
  descriptor: readTool(name),
  execute: () => {
    throw new Error("the core banking service is unavailable");
  },
});

describe("a call that answered nothing", () => {
  it("says so on the repeat, and only on the repeat", async () => {
    const { tools, registry } = turnTools({ search_catalog: emptySearch });
    const first = await tools.call("search_catalog", { query: "chart" });
    const second = await tools.call("search_catalog", { query: "chart" });
    expect(first.note).toBeUndefined();
    expect(second.note).toContain("already made this exact call");
    // The answer itself is untouched, and the call still RAN: the note is a
    // lesson beside the result, never a substitute for it.
    expect(second).toMatchObject({ status: "ok", output: { components: [] } });
    expect(registry.invocations["search_catalog"]).toBe(2);
  });

  it("recognizes the same arguments serialized in another order", async () => {
    const { tools } = turnTools({ search_catalog: emptySearch });
    await tools.call("search_catalog", { query: "chart", limit: 5 });
    const again = await tools.call("search_catalog", { limit: 5, query: "chart" });
    expect(again.note).toContain("already made this exact call");
  });

  it("leaves a tool that legitimately answers empty for DIFFERENT arguments alone", async () => {
    const { tools } = turnTools({ search_catalog: emptySearch });
    const chart = await tools.call("search_catalog", { query: "chart" });
    const table = await tools.call("search_catalog", { query: "table" });
    expect(chart.note).toBeUndefined();
    expect(table.note).toBeUndefined();
  });

  it("is data, not a failure — two empty answers are never 'nothing worked'", async () => {
    const { tools } = turnTools({
      search_catalog: emptySearch,
      list_transfers: { descriptor: readTool("list_transfers"), execute: () => [] },
    });
    const search = await tools.call("search_catalog", { query: "chart" });
    const transfers = await tools.call("list_transfers", {});
    expect(search.note).toBeUndefined();
    expect(transfers.note).toBeUndefined();
  });

  it("counts a real answer as an answer, however small", async () => {
    const { tools } = turnTools({
      get_spending: { descriptor: readTool("get_spending"), execute: () => ({ total: 0 }) },
    });
    await tools.call("get_spending", {});
    const again = await tools.call("get_spending", {});
    expect(again.note).toBeUndefined();
  });
});

describe("a call that failed", () => {
  it("never blocks the retry a transient failure deserves", async () => {
    let attempts = 0;
    const { tools, registry } = turnTools({
      list_transfers: {
        descriptor: readTool("list_transfers"),
        execute: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("the transfers service is temporarily unavailable");
          return [{ id: "tr_2" }];
        },
      },
    });
    const failed = await tools.call("list_transfers", {});
    const retried = await tools.call("list_transfers", {});
    expect(failed.status).toBe("error");
    expect(retried).toMatchObject({ status: "ok", output: [{ id: "tr_2" }] });
    expect(retried.note).toBeUndefined();
    expect(registry.invocations["list_transfers"]).toBe(2);
  });

  it("says so once the same call has failed twice", async () => {
    const { tools } = turnTools({ list_transfers: alwaysFails("list_transfers") });
    const first = await tools.call("list_transfers", {});
    const second = await tools.call("list_transfers", {});
    expect(first.note).toBeUndefined();
    expect(second.note).toContain("failed 2 times");
  });

  it("tells the model plainly when nothing this turn has worked", async () => {
    const { tools } = turnTools({
      list_accounts: alwaysFails("list_accounts"),
      get_spending: alwaysFails("get_spending"),
    });
    const accounts = await tools.call("list_accounts", {});
    const spending = await tools.call("get_spending", {});
    // One failure is a call that may yet be retried; two with nothing succeeding
    // is a turn that has to admit it.
    expect(accounts.note).toBeUndefined();
    expect(spending.note).toContain("Do not answer from memory");
  });

  it("stays quiet while something in the turn is working", async () => {
    const { tools } = turnTools({
      list_accounts: { descriptor: readTool("list_accounts"), execute: () => [{ id: "ac_1" }] },
      get_spending: alwaysFails("get_spending"),
      list_transfers: alwaysFails("list_transfers"),
    });
    await tools.call("list_accounts", {});
    await tools.call("get_spending", {});
    const transfers = await tools.call("list_transfers", {});
    expect(transfers.note).toBeUndefined();
  });
});
