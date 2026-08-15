/**
 * How big a paint may be — asked INSIDE the VM, before the JSON crosses.
 *
 * The host's own gate on a tree (contract/genui/tree.ts) runs after
 * `JSON.parse`, which is one parse too late: the string has already been built
 * and read out of the VM. So the engine measures what it is about to hand over
 * and refuses it with a sentence the screen's author can act on. The node cap is
 * core's `TREE_MAX_NODES` — the same number on both sides of the crossing.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { TREE_MAX_NODES } from "@vendoai/core";
import {
  bootScreen,
  ScreenError,
  wallClockBudget,
  warmScreenEngine,
  type ScreenInstance,
} from "../../../../src/contract/genui/component/index.js";
import { CATALOG, compileScreen } from "./screen-fixture.test-util.js";

beforeAll(async () => {
  await warmScreenEngine();
});

/** A screen that paints thousands of nodes is slow, not runaway — the budget
 *  here is the test's own timeout, so a cap is what refuses it, never a clock. */
const boot = (tsx: string): ScreenInstance => bootScreen({
  compiledSource: compileScreen(tsx),
  queries: {},
  catalog: CATALOG,
  budget: wallClockBudget({ bootMs: 30_000 }),
});

const refusal = (tsx: string): ScreenError => {
  try {
    boot(tsx).dispose();
  } catch (error) {
    if (error instanceof ScreenError) return error;
    throw error;
  }
  throw new Error("expected the screen to be refused");
};

/** `count` rows under one Stack — count + 1 nodes. */
const rows = (count: number): string => `
import { Stack, Text } from "@vendo/screen";
export default function S() {
  return <Stack>{Array.from({ length: ${count} }, (_, i) => <Text key={i} text="r" />)}</Stack>;
}`;

const nested = (levels: number): string => `
import { Stack, Text } from "@vendo/screen";
export default function S() {
  let node = <Text text="deep" />;
  for (let i = 0; i < ${levels}; i++) node = <Stack>{node}</Stack>;
  return node;
}`;

describe("the caps a paint has to fit", () => {
  it("paints TREE_MAX_NODES and refuses one more", () => {
    const screen = boot(rows(TREE_MAX_NODES - 1));
    try {
      expect(screen.tree().children).toHaveLength(TREE_MAX_NODES - 1);
    } finally {
      screen.dispose();
    }

    const error = refusal(rows(TREE_MAX_NODES));
    expect(error.kind).toBe("render");
    expect(error.message).toContain(`more than ${TREE_MAX_NODES} nodes`);
    expect(error.message).toContain("paint a page of rows");
  }, 60_000);

  it("refuses a tree nested deeper than it caps", () => {
    boot(nested(60)).dispose();

    const error = refusal(nested(400));
    expect(error.kind).toBe("render");
    expect(error.message).toContain("deep");
  });

  it("refuses a paint too large to hand over, whatever its shape", () => {
    const error = refusal(`
import { Text } from "@vendo/screen";
export default function S() { return <Text text={"x".repeat(600_000)} />; }`);

    expect(error.kind).toBe("render");
    expect(error.message).toContain("too large");
  });
});
