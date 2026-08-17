/**
 * The Node screen toolchain against the shared conformance table — the real
 * esbuild, the real TypeScript compiler and the real VM, through the whole
 * gauntlet.
 *
 * Plus the one thing no fixture can state: a toolchain that cannot do its job
 * REFUSES. The three lazy loads behind this adapter are the reason the gauntlet
 * exists at all, and a check that read nothing must never answer "fine".
 */
import { describe, expect, it } from "vitest";
import {
  checkComponentScreen,
  type ComponentScreenCheck,
} from "../../src/server/checking/component-screen.js";
import {
  nodeToolchain,
  __setToolchainForTests,
  type ScreenToolchain,
} from "../../src/server/checking/toolchain.js";
import { runToolchainConformance } from "./toolchain-conformance.test-util.js";

describe("the Node screen toolchain", () => {
  runToolchainConformance(nodeToolchain);
});

const PLAIN = `import { Text } from "@vendo/screen";

export default function Rows() {
  return <Text text="hi" />;
}
`;

describe("a toolchain that cannot type-check", () => {
  it("refuses the screen and names why, instead of passing one it never read", async () => {
    const restore = __setToolchainForTests({
      ...nodeToolchain(),
      typecheck: async () => ({ ok: false, why: "the compiler is not reachable here" }),
    });
    try {
      const result = await checkComponentScreen({
        source: PLAIN,
        hostTools: [],
        catalog: ["Text"],
        runQuery: async () => ({}),
      });

      expect(result.ok).toBe(false);
      expect(result.issues).toEqual([{
        code: "typecheck-unavailable",
        message: "the screen could not be type-checked: the compiler is not reachable here."
          + " This check refuses to pass a screen it never read — make the TypeScript compiler"
          + " reachable where the build runs.",
        // The refusal is about this DEPLOYMENT, not the screen: nothing was read,
        // so no rewrite helps, and the mark is what stops a writing loop spending
        // its budget on one (`ComponentPaintResult.environment`).
        environment: true,
      }]);
    } finally {
      restore();
    }
  });
});

describe("a toolchain whose type check REJECTS", () => {
  it("refuses with the same sentence as one that answered { ok: false }", async () => {
    const why = "the compiler is not reachable here";
    const check = async (typecheck: ScreenToolchain["typecheck"]): Promise<ComponentScreenCheck> => {
      const restore = __setToolchainForTests({ ...nodeToolchain(), typecheck });
      try {
        return await checkComponentScreen({
          source: PLAIN,
          hostTools: [],
          catalog: ["Text"],
          runQuery: async () => ({}),
        });
      } finally {
        restore();
      }
    };

    // The whole reason the slot exists is a toolchain reached over a service
    // binding, where a broken call arrives as a rejection rather than a verdict.
    const answered = await check(async () => ({ ok: false, why }));
    const rejected = await check(async () => { throw new Error(why); });

    expect(rejected.ok).toBe(false);
    expect(rejected.issues).toEqual(answered.issues);
    expect(rejected.issues[0]?.code).toBe("typecheck-unavailable");
  });
});
