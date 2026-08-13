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
import { checkComponentScreen } from "../../src/server/checking/component-screen.js";
import { nodeToolchain, __setToolchainForTests } from "../../src/server/checking/toolchain.js";
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
      }]);
    } finally {
      restore();
    }
  });
});
