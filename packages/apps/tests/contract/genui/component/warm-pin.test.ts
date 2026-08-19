/**
 * An explicitly passed variant WINS.
 *
 * `@vendoai/ui` re-warms the engine with no variant of its own the moment a
 * screen mounts (`ui/src/tree/screen-engine.ts`), so a default warm that could
 * take the slot back would discard the host's choice on the first paint — the
 * documented hatch would exist and never hold. That is not hypothetical: it is
 * why genbench's offline single-bundle page could not run screens at all
 * (#1496), and it is the same law every adapter slot in this codebase keeps.
 *
 * The default is made UNLOADABLE here, which is exactly the venue that needs
 * this: a page with no network and no asset URL cannot produce the stock
 * variant's bytes at all. So a screen painting at the end can only mean the
 * pinned variant is the one that ran — with the guard reverted, the default warm
 * runs, throws, and this file goes red.
 *
 * The two tests are ORDERED, because the pin is module state: the unpinned
 * behaviour can only be asked before anything has pinned.
 */
import { describe, expect, it, vi } from "vitest";
import { bootScreen, warmScreenEngine } from "../../../../src/contract/genui/component/index.js";
import { CATALOG, compileScreen, textsOf } from "./screen-fixture.test-util.js";

const NO_BYTES = "this venue cannot produce the stock variant's WebAssembly";

vi.mock("#engine/wasm", () => ({
  default: () => { throw new Error(NO_BYTES); },
}));

const PAINTS = `
import { Text } from "@vendo/screen";
export default function S() { return <Text text="pinned" />; }`;

describe("the variant a host pinned", () => {
  it("is not what an unpinned warm reaches for — that one takes the default, and its failure surfaces", async () => {
    await expect(warmScreenEngine()).rejects.toThrow(NO_BYTES);
  });

  it("survives the library's own default re-warm, and is what boots the screen", async () => {
    const base = (await import("@jitl/quickjs-singlefile-browser-release-sync")).default;
    let builds = 0;
    const pinned = { ...base, importFFI: () => { builds += 1; return base.importFFI(); } };

    await warmScreenEngine(pinned);
    expect(builds).toBe(1);

    // What `@vendoai/ui` calls on every screen mount. It must not reach for the
    // default at all — reaching for it here is the throw above, not a silent swap.
    await expect(warmScreenEngine()).resolves.toBeUndefined();
    expect(builds).toBe(1);

    const screen = bootScreen({ compiledSource: compileScreen(PAINTS), queries: {}, catalog: CATALOG });
    try {
      expect(textsOf(screen.tree())).toEqual(["pinned"]);
    } finally {
      screen.dispose();
    }
  });
});
