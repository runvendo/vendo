/**
 * The edge screen toolchain against the shared conformance table — real sucrase,
 * the real TypeScript compiler over its vendored lib files, and the real VM on a
 * wasmfile variant, through the whole gauntlet.
 *
 * The point of driving the SAME table as `toolchain-node.test.ts` is that the
 * two implementations share nothing: esbuild against sucrase, a compiler off
 * disk against one over string constants, a single-file build against a
 * host-supplied `WebAssembly.Module`. What a screen author reads back must not
 * be able to tell them apart, so the fixtures assert verdicts and sentences, not
 * compiled bytes.
 *
 * `readFileSync` on the variant's `.wasm` is the one thing here that is NOT what
 * production does: workerd cannot compile WebAssembly from bytes at runtime, so
 * a deployment imports the module at deploy time and hands it over. That import
 * is the platform's, not this package's — the seam under test is the
 * `wasmModule` argument, and Node's disk is the cheapest way to produce one.
 *
 * The three tests past the table are the ones no fixture can state: the
 * fail-closed library, and the two fidelity refusals that only mean something if
 * BOTH toolchains fire them on the same screen.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { warmScreenEngine } from "../../src/contract/index.js";
import { checkComponentScreen } from "../../src/server/checking/component-screen.js";
import { edgeToolchain, EDGE_TYPESCRIPT_VERSION } from "../../src/server/edge/index.js";
import { runToolchainConformance } from "./toolchain-conformance.test-util.js";

/** A global on every runtime this package runs on, and in no lib it compiles
 *  against (ES2022, deliberately no DOM). Named where it is used. */
declare const WebAssembly: { Module: new (bytes: Uint8Array) => object };

const wasmModule = new WebAssembly.Module(readFileSync(
  createRequire(import.meta.url).resolve("@jitl/quickjs-wasmfile-release-sync/wasm"),
));

const toolchain = (): ReturnType<typeof edgeToolchain> => edgeToolchain({ wasmModule });

describe("the edge screen toolchain", () => {
  runToolchainConformance(toolchain);

  it("carries the TypeScript its lib files were copied from", () => {
    expect(EDGE_TYPESCRIPT_VERSION).toBe("6.0.3");
  });
});

describe("a standard library the bundle does not carry", () => {
  it("refuses and NAMES the missing lib, instead of a clean answer it never checked", async () => {
    const result = await toolchain().typecheck({
      source: "export default function Screen() { return null; }\n",
      typings: "",
      lib: ["lib.dom.d.ts"],
      components: [],
    });

    expect(result).toEqual({
      ok: false,
      why: 'the bundled TypeScript standard library does not carry "lib.dom.d.ts"',
    });
  });
});

const catalog = ["Text"];

const check = (source: string): ReturnType<typeof checkComponentScreen> => checkComponentScreen({
  source,
  hostTools: [],
  catalog,
  runQuery: async () => ({}),
  toolchain: toolchain(),
});

const NAMESPACE = `import { Text } from "@vendo/screen";

namespace Format {
  export const dash = "—";
}

export default function Screen() {
  return <Text text={Format.dash} />;
}
`;

const STATIC_BLOCK = `import { Text } from "@vendo/screen";

class Labels {
  static heading: string;
  static {
    Labels.heading = "Pending";
  }
}

export default function Screen() {
  return <Text text={Labels.heading} />;
}
`;

/** A screen that only works in SLOPPY mode: the write to a frozen object is
 *  silently dropped there and a TypeError here. */
const SLOPPY = `import { Text } from "@vendo/screen";

const settings: { label: string } = { label: "before" };
Object.freeze(settings);

export default function Screen() {
  settings.label = "after";
  return <Text text={settings.label} />;
}
`;

beforeAll(async () => {
  await warmScreenEngine();
});

describe("the fidelity refusals, through the edge toolchain", () => {
  it("refuses a namespace block", async () => {
    const result = await check(NAMESPACE);

    expect(result.issues.map(({ code }) => code)).toEqual(["namespace"]);
    expect(result.issues[0]?.message).toContain("declares a namespace block (namespace Format { … })");
  });

  it("sees the class static initializer block sucrase leaves standing", async () => {
    const result = await check(STATIC_BLOCK);

    expect(result.issues.map(({ code }) => code)).toEqual(["static-block"]);
    expect(result.issues[0]?.message).toContain("writes a class static initializer block (static { … })");
  });

  it("compiles the engine form strict, so a sloppy-mode screen throws here too", async () => {
    const forms = await toolchain().transform(SLOPPY);
    expect(forms.engine.startsWith('"use strict";')).toBe(true);
    expect(forms.scan).not.toContain('"use strict";');

    const result = await check(SLOPPY);

    expect(result.issues.map(({ code }) => code)).toEqual(["run"]);
    expect(result.issues[0]?.message).toContain("'label' is read-only");
  });
});
