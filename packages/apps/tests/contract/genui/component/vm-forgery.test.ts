/**
 * The tree the host reads is the tree the screen PAINTED.
 *
 * The screen's own code evaluates inside the VM the engine already set up, so
 * every name the engine still reaches for AFTERWARDS is a name the screen can
 * redefine underneath it. A screen that assigned `JSON.stringify` used to hand
 * the host a whole tree it never rendered, and the host validated it and said
 * yes. So the engine holds its intrinsics in closure variables taken before the
 * screen's first line, `__vendo` is not a name the screen can reach, and the
 * emitter reads OWN keys onto a bare object. These are the attempts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ScreenError, warmScreenEngine, type NestedNode } from "../../../../src/contract/genui/component/index.js";
import { bootTsx, nodeOf, textsOf } from "./screen-fixture.test-util.js";

beforeAll(async () => {
  await warmScreenEngine();
});

/** One screen: something the model wrote at module scope, then a paint. */
const paints = (prelude: string, body = `<Text text="real" />`): NestedNode => {
  const screen = bootTsx(`
import { Card, Stack, Text } from "@vendo/screen";
${prelude}
export default function S() { return <Stack>${body}</Stack>; }`);
  try {
    return screen.tree();
  } finally {
    screen.dispose();
  }
};

const FORGED = '{"component":"Card","props":{"title":"forged"},"children":[]}';

describe("a screen cannot forge its own paint", () => {
  it("hands back what it rendered even when it rewrote JSON.stringify", () => {
    const tree = paints(`JSON.stringify = () => ${JSON.stringify(FORGED)};`);

    expect(tree.component).toBe("Stack");
    expect(textsOf(tree)).toEqual(["real"]);
  });

  it("cannot replace the engine's handle, or any function on it", () => {
    const fake = `{
      mount: () => {}, flush: () => 0, resume: () => {}, fire: () => {},
      takeFailure: () => "null", serialize: () => ${JSON.stringify(FORGED)}, tools: {},
    }`;

    expect(() => paints(`globalThis.__vendo = ${fake};`)).toThrow(ScreenError);
    expect(() => paints(`__vendo.serialize = () => ${JSON.stringify(FORGED)};`)).toThrow(ScreenError);
    expect(() => paints(`delete globalThis.__vendo;`)).toThrow(ScreenError);
  });

  it("cannot make an array read back as something else", () => {
    const tree = paints(`Array.isArray = () => false;`, `<Card rows={[1, 2]} />`);

    expect(nodeOf(tree, "Card")?.props.rows).toEqual([1, 2]);
  });

  it("cannot reach the module space the engine loaded it from", () => {
    const tree = paints(`
const reachable = [typeof globalThis.__vendo_modules, typeof globalThis.__vendo_require].join(",");`,
      `<Text text={reachable} />`);

    expect(textsOf(tree)).toEqual(["undefined,undefined"]);
  });
});

describe("what crosses as props", () => {
  it("is the object's own keys, never its prototype's", () => {
    const tree = paints(`
function Bag() {}
Bag.prototype.inherited = "leaked";
const instance = new Bag();
instance.own = "kept";`, `<Card meta={instance} />`);

    expect(nodeOf(tree, "Card")?.props.meta).toEqual({ own: "kept" });
  });

  it("drops the keys that mean the prototype chain on the host's side", () => {
    const tree = paints(`
const bag = { safe: 1 };
Object.defineProperty(bag, "__proto__", { value: { role: "admin" }, enumerable: true });
Object.defineProperty(bag, "constructor", { value: "forged", enumerable: true });
Object.defineProperty(bag, "prototype", { value: "forged", enumerable: true });`,
      `<Card meta={bag} />`);

    expect(Object.keys(nodeOf(tree, "Card")?.props.meta as object)).toEqual(["safe"]);
    expect(({} as { role?: string }).role).toBeUndefined();
  });
});
