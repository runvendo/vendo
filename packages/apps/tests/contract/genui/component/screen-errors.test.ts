/**
 * What a broken screen does — and the promise that holds it together: A THROW
 * LEAVES THE SCREEN STANDING.
 *
 * A handler that throws, or that never finishes, raises a {@link ScreenError} out
 * of `fire` and the instance stays usable, still showing the tree it last
 * painted. That is the honest answer for a surface: one broken button does not
 * take the screen down. Each `kind` is a different repair, and every message here
 * is read by whatever fixes the screen — so the sentences are asserted, not just
 * the kinds.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  bootScreen,
  ScreenError,
  warmScreenEngine,
  type ScreenErrorKind,
} from "../../../../src/contract/genui/component/index.js";
import { bootTsx, CATALOG, compileScreen, textsOf } from "./screen-fixture.test-util.js";

beforeAll(async () => {
  await warmScreenEngine();
});

/** The error a call raised, as a ScreenError — anything else is a test failure,
 *  because the engine's whole contract is that failures arrive in this shape. */
const raised = (body: () => unknown): ScreenError => {
  try {
    body();
  } catch (error) {
    if (error instanceof ScreenError) return error;
    throw new Error(`expected a ScreenError, got ${String(error)}`);
  }
  throw new Error("expected a ScreenError, got no throw at all");
};

const failsBoot = (tsx: string, queries: Record<string, unknown> = {}): ScreenError =>
  raised(() => bootTsx(tsx, queries));

describe("a handler that fails", () => {
  const THROWING = `
import { useState } from "react";
import { Button, Stack, Text } from "@vendo/screen";
export default function S() {
  const [count, setCount] = useState(0);
  return (
    <Stack>
      <Text text={"clicked " + count} />
      <Button label="throws" onClick={() => { throw new Error("the row is gone"); }} />
      <Button label="rejects" onClick={async () => { await null; throw new TypeError("nothing to cancel"); }} />
      <Button label="works" onClick={() => setCount(count + 1)} />
    </Stack>
  );
}`;

  it("raises the in-VM message verbatim and leaves the screen usable", () => {
    const screen = bootTsx(THROWING);
    try {
      const error = raised(() => screen.fire("h1"));

      expect(error.kind).toBe("handler");
      expect(error.name).toBe("ScreenError");
      expect(error.message).toBe("the row is gone");
      // The stack is the VM's own, passed through for whoever repairs the screen.
      expect(error.vmStack).toContain("at");

      // Still standing, still showing its last paint — and the next click works.
      expect(textsOf(screen.tree())).toEqual(["clicked 0"]);
      expect(textsOf(screen.fire("h3").tree)).toEqual(["clicked 1"]);
    } finally {
      screen.dispose();
    }
  });

  it("surfaces an ASYNC handler's throw, which lands after the call returned", () => {
    const screen = bootTsx(THROWING);
    try {
      const error = raised(() => screen.fire("h2"));

      expect(error.kind).toBe("handler");
      // The engine parked this one inside the VM and the host read it back once
      // the queues were quiet, so it carries the thrown MESSAGE; the synchronous
      // path above reads the error object itself and prefixes its class name.
      expect(error.message).toContain("nothing to cancel");
      expect(textsOf(screen.fire("h3").tree)).toEqual(["clicked 1"]);
    } finally {
      screen.dispose();
    }
  });

  it("reads a throw that is not an Error at all, rather than saying [object Object]", () => {
    const screen = bootTsx(`
import { Button, Stack } from "@vendo/screen";
export default function S() {
  return (
    <Stack>
      <Button label="string" onClick={() => { throw "the row is gone"; }} />
      <Button label="bag" onClick={() => { throw { code: 7 }; }} />
    </Stack>
  );
}`);
    try {
      // Whatever the screen threw, the message is what repairs it.
      expect(raised(() => screen.fire("h1")).message).toBe("the row is gone");
      expect(raised(() => screen.fire("h2")).message).toBe('{"code":7}');
    } finally {
      screen.dispose();
    }
  });

  it("drops the tool calls a failed turn recorded, rather than leaving them pending", () => {
    const screen = bootTsx(`
import { Button, Stack, Text, tools } from "@vendo/screen";
export default function S() {
  return (
    <Stack>
      <Text text="standing" />
      <Button label="go" onClick={() => { tools.pay({ id: 1 }); throw new Error("changed my mind"); }} />
    </Stack>
  );
}`);
    try {
      // The turn never reached its caller, so the intent it recorded can never be
      // settled — a host that answered it would be resuming a handler that died.
      expect(raised(() => screen.fire("h1")).message).toBe("changed my mind");
      expect(raised(() => screen.settle("i1", { status: "ok", output: null })).message)
        .toContain('no tool call "i1" is waiting on this screen');
      expect(textsOf(screen.tree())).toEqual(["standing"]);
    } finally {
      screen.dispose();
    }
  });

  it("says how many handlers the last paint named when an id does not exist", () => {
    const screen = bootTsx(THROWING);
    try {
      const error = raised(() => screen.fire("h99"));

      expect(error.kind).toBe("handler");
      expect(error.message).toContain('no handler "h99" is on this screen');
      expect(error.message).toContain("it named 3 handler(s) at its last paint");
      expect(error.message).toContain("deliver an event from the tree you are showing");
    } finally {
      screen.dispose();
    }
  });

  it("refuses a tool answer nobody is waiting for, and says both reasons", () => {
    const screen = bootTsx(`
import { Button, Stack, tools } from "@vendo/screen";
export default function S() {
  return <Stack><Button label="pay" onClick={async () => { await tools.pay({ id: 1 }); }} /></Stack>;
}`);
    try {
      const fired = screen.fire("h1");
      screen.settle("i1", { status: "ok", output: null });

      const error = raised(() => screen.settle(fired.intents[0]?.id ?? "", { status: "ok", output: null }));
      expect(error.kind).toBe("handler");
      expect(error.message).toContain('no tool call "i1" is waiting on this screen');
      expect(error.message).toContain("already settled");
      expect(raised(() => screen.settle("i404", null)).message).toContain('"i404"');
    } finally {
      screen.dispose();
    }
  });

  it("raises an unguarded refusal out of settle with the host's sentence, tree still standing", () => {
    const screen = bootTsx(`
import { useState } from "react";
import { Button, Stack, Text, tools } from "@vendo/screen";
export default function S() {
  const [said, setSaid] = useState("idle");
  return (
    <Stack>
      <Text text={said} />
      <Button label="pay" onClick={async () => { await tools.pay({ id: 1 }); setSaid("paid"); }} />
    </Stack>
  );
}`);
    try {
      const fired = screen.fire("h1");
      const error = raised(() => screen.settle(fired.intents[0]?.id ?? "", {
        status: "error",
        error: { code: "bank", message: "the account is closed" },
      }));

      expect(error.kind).toBe("handler");
      expect(error.message).toBe("the account is closed");
      expect(textsOf(screen.tree())).toEqual(["idle"]);
    } finally {
      screen.dispose();
    }
  });

  it("uses the host's own wording for an outcome it cannot read at all", () => {
    const screen = bootTsx(`
import { useState } from "react";
import { Button, Stack, Text, tools } from "@vendo/screen";
export default function S() {
  const [said, setSaid] = useState("idle");
  return (
    <Stack>
      <Text text={said} />
      <Button label="pay" onClick={async () => {
        try { await tools.pay({ id: 1 }); } catch (error) { setSaid("caught: " + error.message); }
      }} />
    </Stack>
  );
}`);
    try {
      const fired = screen.fire("h1");
      const step = screen.settle(fired.intents[0]?.id ?? "", { status: "half-done" });

      expect(textsOf(step?.tree ?? screen.tree())[0])
        .toContain('this tool call came back "half-done", which is not an outcome this screen can read');
      // The two outcomes that carry no sentence of their own still say something.
      const second = screen.fire("h1");
      screen.settle(second.intents[0]?.id ?? "", { status: "error" });
      expect(textsOf(screen.tree())).toEqual(["caught: this tool call failed"]);
      const third = screen.fire("h1");
      screen.settle(third.intents[0]?.id ?? "", { status: "blocked" });
      expect(textsOf(screen.tree())).toEqual(["caught: this tool call was not allowed"]);
    } finally {
      screen.dispose();
    }
  });
});

describe("work that will not finish", () => {
  it("kills a runaway handler on the wall clock and keeps the screen alive", () => {
    const screen = bootTsx(`
import { useState } from "react";
import { Button, Stack, Text } from "@vendo/screen";
export default function S() {
  const [count, setCount] = useState(0);
  return (
    <Stack>
      <Text text={"clicked " + count} />
      <Button label="spin" onClick={() => { while (true) {} }} />
      <Button label="works" onClick={() => setCount(count + 1)} />
    </Stack>
  );
}`);
    try {
      const started = Date.now();
      const error = raised(() => screen.fire("h1"));
      const spent = Date.now() - started;

      expect(error.kind).toBe("budget");
      expect(error.message).toContain("did not finish inside 200ms");
      expect(error.message).toContain("a loop that never ends, or work too heavy for a paint");
      // A wall-clock budget, not an instruction count: the kill lands in the
      // fifth of a second it promises, whatever the loop happens to contain.
      expect(spent).toBeLessThan(5_000);

      expect(textsOf(screen.fire("h2").tree)).toEqual(["clicked 1"]);
    } finally {
      screen.dispose();
    }
  });

  it("stops a screen that re-renders forever, and says which shape does it", () => {
    // An effect that sets the same state on every run: the queue never empties, so
    // the drain — not the clock — is what catches it.
    const error = failsBoot(`
import { useEffect, useState } from "react";
import { Text } from "@vendo/screen";
export default function S() {
  const [count, setCount] = useState(0);
  useEffect(() => { setCount(count + 1); });
  return <Text text={String(count)} />;
}`);

    expect(error.kind).toBe("handler");
    expect(error.message).toContain("this screen never stopped re-rendering");
    expect(error.message).toContain("a state update during render or inside an effect that sets the same state every time");
  });

  it("stops a screen that schedules work off the back of every paint", () => {
    // Not a tight loop and not a re-render loop: each paint schedules a microtask
    // that sets state, so both queues keep answering each other. The drain's own
    // turn limit is what catches this shape.
    const error = failsBoot(`
import { useEffect, useState } from "react";
import { Text } from "@vendo/screen";
export default function S() {
  const [count, setCount] = useState(0);
  useEffect(() => { Promise.resolve().then(() => setCount(count + 1)); }, [count]);
  return <Text text={String(count)} />;
}`);

    expect(error.kind).toBe("budget");
    expect(error.message).toBe("this screen scheduled more work after every paint and never settled");
  });

  it("kills a screen that loops while it renders", () => {
    const error = failsBoot(`
import { Text } from "@vendo/screen";
export default function S() { while (true) {} return <Text text="never" />; }`);

    expect(error.kind).toBe("budget");
    // The BOOT budget, not an event's: boot parses Preact and the screen before it
    // paints, so it gets ten times as long — and the sentence has to name the limit
    // the screen actually blew, or a repair goes after the wrong problem.
    expect(error.message).toContain("did not finish inside 2000ms");
  });

  // Quarantined 2026-08-11: deterministic-red on the release workflow's serial
  // single-runner pass while green on sharded CI — on a loaded runner the 5M-row
  // allocation can trip the 2000ms boot budget before the per-VM heap limit, so
  // the error kind races between "budget" and "boot". Root-cause + un-skip
  // tracked in the follow-up issue; do not delete: this guards engine survival.
  it.skip("raises an out-of-memory screen as a catchable failure, and the engine survives it", () => {
    const error = failsBoot(`
import { Text } from "@vendo/screen";
export default function S() {
  const rows = [];
  for (let index = 0; index < 5000000; index += 1) rows.push({ index: index, label: "row " + index });
  return <Text text={String(rows.length)} />;
}`);

    expect(error.kind).toBe("boot");
    expect(error.message).toContain("out of memory");

    // The heap limit is per VM, so the next screen boots as if nothing happened —
    // this is the difference between a bounded screen and a crashed surface.
    const next = bootTsx(`
import { Text } from "@vendo/screen";
export default function S() { return <Text text="fine" />; }`);
    try {
      expect(textsOf(next.tree())).toEqual(["fine"]);
    } finally {
      next.dispose();
    }
  });

  it("bounds its own stack, so a self-recursive component is catchable", () => {
    const error = failsBoot(`
import { Text } from "@vendo/screen";
export default function Loop() { return <Loop />; }`);

    expect(error.kind).toBe("boot");
    expect(error.message).toContain("stack overflow");
  });
});

describe("a screen that cannot paint", () => {
  it("refuses a screen that returned null, and names the empty state instead", () => {
    const error = failsBoot(`export default function S() { return null; }`);

    expect(error.kind).toBe("render");
    expect(error.message).toContain("this screen painted nothing — it returned null");
    expect(error.message).toContain("an empty result is an empty-state component");
  });

  it("refuses two roots, and says to wrap them", () => {
    const error = failsBoot(`
import { Text } from "@vendo/screen";
export default function S() {
  return [<Text key="a" text="a" />, <Text key="b" text="b" />];
}`);

    expect(error.kind).toBe("render");
    expect(error.message).toContain("a screen must paint exactly one root element, and this one painted 2");
  });

  it("refuses a COMPONENT as a prop value, and names the slot it was written in", () => {
    const error = failsBoot(`
import { Card, Text } from "@vendo/screen";
function Inner() { return <Text text="x" />; }
export default function S() { return <Card title="t" description={<Inner />} />; }`);

    expect(error.kind).toBe("render");
    expect(error.message).toContain("a component cannot be passed as a prop value (at root.0#description)");
    expect(error.message).toContain("pass it as children, or pass the data it needs");
  });
});

describe("a screen that cannot load", () => {
  it("names the ES-module mistake rather than passing the parser's complaint along", () => {
    const error = raised(() => bootScreen({
      // NOT compiled to CJS — the one boot failure worth naming, because the
      // parser's own complaint about a top-level `import` teaches nothing.
      compiledSource: 'import { Text } from "@vendo/screen";\nexport default function S() { return null; }',
      queries: {},
      catalog: CATALOG,
    }));

    expect(error.kind).toBe("boot");
    expect(error.message).toContain("this source looks like an ES module");
    expect(error.message).toContain('compile it with esbuild\'s format: "cjs"');
  });

  it("refuses a file with no default-exported component", () => {
    const error = failsBoot(`
import { Text } from "@vendo/screen";
export function Screen() { return <Text text="x" />; }`);

    expect(error.kind).toBe("boot");
    expect(error.message).toContain("this screen exports no component");
  });

  it("lists the queries a screen really has when it reads one it never declared", () => {
    const error = failsBoot(`
import { Text, useQuery } from "@vendo/screen";
export default function S() { return <Text text={String(useQuery("ghost_tool").length)} />; }`, { list_pending: { data: [] } });

    expect(error.kind).toBe("boot");
    expect(error.message).toContain('useQuery("ghost_tool") — this screen declared no such query');
    expect(error.message).toContain("it has list_pending");
  });

  it("lists the modules a screen may import when it reaches for another", () => {
    const error = failsBoot(`
import { Text } from "@vendo/screen";
import { z } from "zod";
export default function S() { return <Text text={String(z)} />; }`);

    expect(error.kind).toBe("boot");
    expect(error.message).toContain('a screen cannot import "zod"');
    expect(error.message).toContain("react, react/jsx-runtime, react/jsx-dev-runtime, @vendo/screen");
  });
});

describe("warmScreenEngine", () => {
  it("is the precondition bootScreen states, rather than a TypeError from inside", async () => {
    // A fresh module registry is an unwarmed engine: the WebAssembly handle is
    // module state, and a caller that skipped the await has to be told which call
    // it skipped.
    vi.resetModules();
    const fresh = await import("../../../../src/contract/genui/component/boot.js");

    // A fresh registry carries its own ScreenError class, so this one is read by
    // shape rather than by `instanceof`.
    let thrown: unknown;
    try {
      fresh.bootScreen({
        compiledSource: compileScreen(`
import { Text } from "@vendo/screen";
export default function S() { return <Text text="x" />; }`),
        queries: {},
        catalog: CATALOG,
      });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as { kind: ScreenErrorKind; message: string; name: string };

    expect(error.name).toBe("ScreenError");
    expect(error.kind).toBe("boot");
    expect(error.message).toContain("the screen engine is not warm yet");
    expect(error.message).toContain("await warmScreenEngine() once before booting a screen");

    // …and after the await, the same module boots screens.
    await fresh.warmScreenEngine();
    const screen = fresh.bootScreen({
      compiledSource: compileScreen(`
import { Text } from "@vendo/screen";
export default function S() { return <Text text="warm" />; }`),
      queries: {},
      catalog: CATALOG,
    });
    try {
      expect(textsOf(screen.tree())).toEqual(["warm"]);
    } finally {
      screen.dispose();
    }
  });
});
