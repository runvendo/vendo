/**
 * What contains a runaway screen — and why the clock is not always the answer.
 *
 * Wall-clock is the right question in Node and the WRONG one on Cloudflare
 * Workers: workerd freezes `Date.now()` and `performance.now()` for the whole of
 * a synchronous burn, so a deadline handler is asked "is it past 3pm" a million
 * times and truthfully answers "no" every time. A measured runaway screen spent
 * 37 seconds of CPU that way and died on a platform error instead of a refusal.
 * An interrupt COUNT rises whether or not the clock does, so it is what holds on
 * the edge.
 *
 * The two implementations are asserted against the same three questions: does a
 * legitimate screen paint, does a runaway stop, and does the refusal name the
 * limit the screen actually blew. Plus the one that only matters here: with an
 * unset budget, every sentence is byte-for-byte the one `screen-errors` pins.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  BOOT_INTERRUPT_BUDGET,
  bootScreen,
  OP_INTERRUPT_BUDGET,
  opsBudget,
  ScreenError,
  wallClockBudget,
  warmScreenEngine,
  type ScreenBudget,
  type ScreenInstance,
  type ScreenTurn,
} from "../../../../src/contract/genui/component/index.js";
import { CATALOG, compileScreen, textsOf } from "./screen-fixture.test-util.js";

beforeAll(async () => {
  await warmScreenEngine();
});

const boot = (tsx: string, budget?: ScreenBudget): ScreenInstance => bootScreen({
  compiledSource: compileScreen(tsx),
  queries: {},
  catalog: CATALOG,
  ...(budget === undefined ? {} : { budget }),
});

const raised = (body: () => unknown): ScreenError => {
  try {
    body();
  } catch (error) {
    if (error instanceof ScreenError) return error;
    throw new Error(`expected a ScreenError, got ${String(error)}`);
  }
  throw new Error("expected a ScreenError, got no throw at all");
};

/** Loops in the component body, so it never reaches a first paint. */
const SPINS_ON_RENDER = `
import { Text } from "@vendo/screen";
export default function S() { while (true) {} return <Text text="never" />; }`;

/** Boots fine, then loops inside the click — the OP turn's problem. */
const SPINS_ON_CLICK = `
import { Button, Stack, Text } from "@vendo/screen";
export default function S() {
  return (
    <Stack>
      <Text text="ready" />
      <Button label="spin" onClick={() => { while (true) {} }} />
    </Stack>
  );
}`;

/** Real work: the table the op budget was calibrated against. */
const SIXTY_ROWS = `
import { useState } from "react";
import { Button, DataTable, Stack, Text } from "@vendo/screen";
export default function S() {
  const [round, setRound] = useState(0);
  const rows = [];
  for (let index = 0; index < 60; index += 1) rows.push({ id: index, label: "row " + index + " of round " + round });
  return (
    <Stack>
      <Text text={"round " + round} />
      <DataTable rows={rows} />
      <Button label="again" onClick={() => setRound((value) => value + 1)} />
    </Stack>
  );
}`;

/** A budget that reports what its turns actually spent — the calibration read. */
const counting = (inner: ScreenBudget): { budget: ScreenBudget; spent: Record<ScreenTurn, number> } => {
  const spent: Record<ScreenTurn, number> = { boot: 0, op: 0 };
  return {
    spent,
    budget: {
      limit: (turn) => {
        const limit = inner.limit(turn);
        return { ...limit, handler: (runtime) => { spent[turn] += 1; return limit.handler(runtime); } };
      },
    },
  };
};

describe("no budget supplied", () => {
  it("refuses in exactly the words it refused in before there was a budget interface", () => {
    const booted = raised(() => boot(SPINS_ON_RENDER));
    expect(booted.kind).toBe("budget");
    expect(booted.message).toBe("this screen did not finish inside 2000ms — a loop that never ends, or work too heavy for a paint");

    const screen = boot(SPINS_ON_CLICK);
    try {
      const clicked = raised(() => screen.fire("h1"));
      expect(clicked.kind).toBe("budget");
      expect(clicked.message).toBe("this screen did not finish inside 200ms — a loop that never ends, or work too heavy for a paint");
    } finally {
      screen.dispose();
    }
  });
});

describe("wallClockBudget", () => {
  it("takes the boot's milliseconds and says the number it was given", () => {
    const error = raised(() => boot(SPINS_ON_RENDER, wallClockBudget({ bootMs: 300 })));

    expect(error.kind).toBe("budget");
    expect(error.message).toBe("this screen did not finish inside 300ms — a loop that never ends, or work too heavy for a paint");
  });

  it("takes an event's milliseconds without touching the boot's", () => {
    // Only `opMs` is set, so this screen boots on the stock 2000ms — a custom
    // knob must not quietly re-budget the other turn.
    const screen = boot(SPINS_ON_CLICK, wallClockBudget({ opMs: 50 }));
    try {
      expect(textsOf(screen.tree())).toEqual(["ready"]);

      const error = raised(() => screen.fire("h1"));
      expect(error.kind).toBe("budget");
      expect(error.message).toBe("this screen did not finish inside 50ms — a loop that never ends, or work too heavy for a paint");
    } finally {
      screen.dispose();
    }
  });
});

describe("opsBudget", () => {
  it("paints a 60-row screen and re-paints it, well inside the stock counts", () => {
    const counted = counting(opsBudget());
    const screen = boot(SIXTY_ROWS, counted.budget);
    try {
      expect(textsOf(screen.tree())).toContain("round 0");
      screen.fire("h1");
      expect(textsOf(screen.tree())).toContain("round 1");

      // The calibration, asserted rather than commented. QuickJS comes up for
      // air about every ten thousand bytecode operations, so real work is
      // measured in single interrupts: this boot spends 1 and the re-paint 0,
      // against budgets of 7000 and 650. These bounds are the ratchet — a
      // legitimate render climbing into the hundreds means the counts want
      // re-measuring, not raising.
      expect(counted.spent.boot).toBeLessThan(100);
      expect(counted.spent.op).toBeLessThan(10);
    } finally {
      screen.dispose();
    }
  });

  it("stops a runaway on the STOCK counts, which is what the edge will run", () => {
    // The other direction of the calibration: 650 has to be a real limit, not
    // only headroom. Measured, this lands in ~60-125ms — under the 200ms the
    // wall clock would have taken, and the boot's 7000 lands at ~2.2s.
    const screen = boot(SPINS_ON_CLICK, opsBudget());
    try {
      const error = raised(() => screen.fire("h1"));

      expect(error.kind).toBe("budget");
      expect(error.message).toBe(`this screen did not finish inside ${OP_INTERRUPT_BUDGET} interrupts — a loop that never ends, or work too heavy for a paint`);
    } finally {
      screen.dispose();
    }
  });

  it("stops a screen that loops while it renders, and names the count it blew", () => {
    const error = raised(() => boot(SPINS_ON_RENDER, opsBudget({ bootInterrupts: 5 })));

    expect(error.kind).toBe("budget");
    expect(error.message).toContain("5 interrupts");
  });

  it("stops a runaway click, and names the event's count rather than the boot's", () => {
    const screen = boot(SPINS_ON_CLICK, opsBudget({ opInterrupts: 5 }));
    try {
      const error = raised(() => screen.fire("h1"));

      expect(error.kind).toBe("budget");
      expect(error.message).toContain("5 interrupts");
      expect(error.message).not.toContain(String(BOOT_INTERRUPT_BUDGET));
    } finally {
      screen.dispose();
    }
  });

  it("still stops a runaway when the clock is frozen, which is workerd's whole problem", () => {
    // The measured platform behaviour, reproduced: `Date.now()` never moves for
    // the duration of the burn. A deadline handler would answer "not yet"
    // forever and this test would hang; a counter cannot be frozen.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const error = raised(() => boot(SPINS_ON_RENDER, opsBudget({ bootInterrupts: 200 })));

      expect(error.kind).toBe("budget");
      expect(error.message).toContain("200 interrupts");
    } finally {
      clock.mockRestore();
    }
  });
});

describe("warmScreenEngine's variant", () => {
  it("builds one engine per variant, and never hands one variant's engine to another", async () => {
    const base = (await import("@jitl/quickjs-singlefile-browser-release-sync")).default;
    // The engine builder calls `importFFI` exactly once per engine it builds, so
    // counting that call is how many engines a variant got.
    const counted = (): { variant: typeof base; builds: () => number } => {
      let builds = 0;
      return { variant: { ...base, importFFI: () => { builds += 1; return base.importFFI(); } }, builds: () => builds };
    };
    const first = counted();
    const second = counted();

    await warmScreenEngine(first.variant);
    await warmScreenEngine(first.variant);
    expect(first.builds()).toBe(1);

    await warmScreenEngine(second.variant);
    expect(second.builds()).toBe(1);
    expect(first.builds()).toBe(1);

    // …and the no-arg default is an entry of its own, still booting screens.
    await warmScreenEngine();
    const screen = boot(`
import { Text } from "@vendo/screen";
export default function S() { return <Text text="warm" />; }`);
    try {
      expect(textsOf(screen.tree())).toEqual(["warm"]);
    } finally {
      screen.dispose();
    }
  });
});
