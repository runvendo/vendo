/**
 * The seal — what the VM must NOT have, asserted from inside it.
 *
 * This is `$expr`'s seal sized for a component (contract/genui/expr.ts keeps the
 * same one), and its purpose is a single sentence: one screen over one set of
 * data paints the same twice. So the clock and the random generator are gone,
 * the timers are gone, the network was never there, and the module space is four
 * names long. Each removal is asserted by a screen that reaches for the thing —
 * because a seal nobody tries is a seal nobody has.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ScreenError, warmScreenEngine } from "../../../../src/contract/genui/component/index.js";
import { bootTsx, textsOf } from "./screen-fixture.test-util.js";

beforeAll(async () => {
  await warmScreenEngine();
});

/** One screen whose whole job is to say what it found — the cheapest way to ask
 *  the inside of the VM a question. */
const says = (body: string, queries: Record<string, unknown> = {}, now?: number): string[] => {
  const screen = bootTsx(`
import { Text } from "@vendo/screen";
export default function S() {
  ${body}
  return <Text text={String(answer)} />;
}`, queries, now);
  try {
    return textsOf(screen.tree());
  } finally {
    screen.dispose();
  }
};

const refuses = (body: string, now?: number): ScreenError => {
  try {
    says(body, {}, now);
  } catch (error) {
    if (error instanceof ScreenError) return error;
    throw error;
  }
  throw new Error("expected the screen to be refused");
};

describe("the clock", () => {
  it("does not exist at all when the host withheld one", () => {
    // Withheld, `Date` is DELETED rather than replaced: there is no reading of
    // "now" that could be honest, and a screen that reads one must not paint.
    expect(says(`const answer = typeof Date;`)).toEqual(["undefined"]);
    expect(refuses(`const answer = Date.now();`).message).toContain("'Date' is not defined");
    expect(refuses(`const answer = new Date().getFullYear();`).message).toContain("'Date' is not defined");
  });

  it("reads one frozen instant when the host gave one", () => {
    const noon = Date.UTC(2026, 0, 2, 12, 0, 0);

    expect(says(`const answer = Date.now();`, {}, noon)).toEqual([String(noon)]);
    expect(says(`const answer = new Date().toISOString();`, {}, noon)).toEqual(["2026-01-02T12:00:00.000Z"]);
    // Real Date behaviour otherwise: the prototype is the real one, and an
    // EXPLICIT argument is honoured — a screen formats the dates its data carries.
    expect(says(`const answer = new Date().getUTCFullYear();`, {}, noon)).toEqual(["2026"]);
    expect(says(`const answer = new Date("2020-03-04T05:06:07.000Z").toISOString();`, {}, noon))
      .toEqual(["2020-03-04T05:06:07.000Z"]);
    expect(says(`const answer = Date.parse("2020-01-01T00:00:00.000Z");`, {}, noon))
      .toEqual([String(Date.parse("2020-01-01T00:00:00.000Z"))]);
    expect(says(`const answer = Date.UTC(2021, 0, 1);`, {}, noon)).toEqual([String(Date.UTC(2021, 0, 1))]);
  });

  it("paints the same twice on one clock, and differently on another", () => {
    const morning = says(`const answer = Date.now();`, {}, 1_000);
    expect(says(`const answer = Date.now();`, {}, 1_000)).toEqual(morning);
    expect(says(`const answer = Date.now();`, {}, 2_000)).not.toEqual(morning);
  });
});

describe("what a screen cannot reach", () => {
  it("refuses Math.random with the reason, rather than a missing function", () => {
    const error = refuses(`const answer = Math.random();`);

    expect(error.message).toContain("Math.random() is not available here");
    expect(error.message).toContain("a screen has to paint the same twice");
    // The rest of Math is untouched — the seal is about determinism, not arithmetic.
    expect(says(`const answer = Math.round(Math.max(1.4, 1.2) * 10);`)).toEqual(["14"]);
  });

  it("refuses the timers, and says a screen paints from data and events", () => {
    for (const timer of ["setTimeout(function () {}, 0)", "setInterval(function () {}, 0)"]) {
      const error = refuses(`const answer = ${timer};`);
      expect(error.message).toContain("is not available in a screen");
      expect(error.message).toContain("a screen paints from its query data and from events, never from a clock");
    }
    // Their cancels are no-ops rather than throws: cleanup code that runs on the
    // way out must not be the thing that breaks the paint.
    expect(says(`clearTimeout(1); clearInterval(2); const answer = "cleaned";`)).toEqual(["cleaned"]);
  });

  it("has no network, no storage, no process, and no host object", () => {
    expect(says(`const answer = [
      typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof process, typeof localStorage, typeof window,
    ].join(",");`)).toEqual(["undefined,undefined,undefined,undefined,undefined,undefined"]);
  });

  it("cannot reach the engine's own tool bridge or the Preact it runs on", () => {
    // The engine captures these four at install and deletes them, so the screen's
    // own code cannot call the bridge directly or re-render into a second root.
    expect(says(`const answer = [
      typeof globalThis.__vendo_tool, typeof globalThis.preact, typeof globalThis.preactHooks, typeof globalThis.jsxRuntime,
    ].join(",");`)).toEqual(["undefined,undefined,undefined,undefined"]);
  });

  it("keeps a stray console.log from taking the screen down", () => {
    // `console` is the one name ADDED rather than removed: a bare context has
    // none, and a debug line the model forgot to delete is not a capability.
    expect(says(`console.log("still here"); console.warn("x"); console.error("y"); const answer = "painted";`))
      .toEqual(["painted"]);
  });
});

describe("the module space", () => {
  it("is React's real surface, minus the four names that would let a screen out", () => {
    expect(says(`
    const react = require("react");
    const answer = [
      typeof react.useState, typeof react.useReducer, typeof react.useMemo, typeof react.useRef,
      typeof react.createContext, typeof react.memo, typeof react.forwardRef, typeof react.Children.map,
      typeof react.render, typeof react.hydrate, typeof react.options, typeof react.createPortal,
    ].join(",");`)).toEqual([
      "function,function,function,function,function,function,function,function,undefined,undefined,undefined,undefined",
    ]);
  });

  it("runs the hooks for real — a reducer, a memo, a context, a ref", () => {
    const screen = bootTsx(`
import { createContext, useContext, useMemo, useReducer, useRef, useState } from "react";
import { Button, Stack, Text } from "@vendo/screen";

const Currency = createContext("USD");

function Total({ cents }) {
  const currency = useContext(Currency);
  const label = useMemo(() => currency + " " + (cents / 100).toFixed(2), [currency, cents]);
  return <Text text={label} />;
}

export default function S() {
  const [count, bump] = useReducer((value, step) => value + step, 0);
  const renders = useRef(0);
  const [, setTouched] = useState(false);
  renders.current += 1;
  return (
    <Stack>
      <Currency.Provider value="EUR">
        <Total cents={1234 + count} />
      </Currency.Provider>
      <Text text={"renders " + renders.current} />
      <Button label="bump" onClick={() => { bump(100); setTouched(true); }} />
    </Stack>
  );
}`);
    try {
      expect(textsOf(screen.tree())).toEqual(["EUR 12.34", "renders 1"]);
      // A context consumer inside a component is transparent to the host — the
      // provider and the consumer contribute their children, never a node.
      expect(screen.tree().children.map((child) => typeof child === "string" ? child : child.component))
        .toEqual(["Text", "Text", "Button"]);
      expect(textsOf(screen.fire("h1").tree)).toEqual(["EUR 13.34", "renders 2"]);
    } finally {
      screen.dispose();
    }
  });

  it("refuses `tools` as a callable of its own, and every call while the screen renders", () => {
    const reaching = (expression: string): ScreenError => {
      try {
        bootTsx(`
import { Text, tools } from "@vendo/screen";
export default function S() { return <Text text={String(${expression})} />; }`).dispose();
      } catch (error) {
        if (error instanceof ScreenError) return error;
        throw error;
      }
      throw new Error("expected the screen to be refused");
    };

    const bare = reaching("tools()");
    expect(bare.message).toContain("tools is not itself a tool");
    expect(bare.message).toContain("call one on it, like tools.cancel_transfer({ id })");

    const rendering = reaching('tools.cancel_transfer({ id: "tr_1" })');
    expect(rendering.message).toContain("cannot run while the screen renders");
    expect(rendering.message).toContain("tools run inside event handlers, and a screen paints from its useQuery data");
  });
});

describe("the data crossing", () => {
  it("hands the screen its own COPY of the query results", () => {
    const rows = { data: [{ id: "tr_1" }] };
    const screen = bootTsx(`
import { Button, Stack, Text, useQuery } from "@vendo/screen";
export default function S() {
  const pending = useQuery("list_pending");
  return (
    <Stack>
      <Text text={"rows " + pending.data.length} />
      <Button label="scribble" onClick={() => { pending.data.push({ id: "invented" }); }} />
    </Stack>
  );
}`, { list_pending: rows });
    try {
      screen.fire("h1");
      // The VM is a different realm and the data crossed as JSON, so a screen
      // cannot reach back into the host's object.
      expect(rows.data).toEqual([{ id: "tr_1" }]);
    } finally {
      screen.dispose();
    }
  });

  it("gives every catalog name to the screen as a component it can render", () => {
    const screen = bootTsx(`
import { Card, Money, Row, Stack, Text } from "@vendo/screen";
export default function S() {
  return <Stack><Row><Card title="c"><Money amount={1} /><Text text="t" /></Card></Row></Stack>;
}`);
    try {
      // A name from the catalog IS the component: the engine gives the screen the
      // string, and the host's renderer is what turns it into pixels.
      expect(JSON.stringify(screen.tree())).toContain('"component":"Money"');
    } finally {
      screen.dispose();
    }
  });
});
