import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** CORE-10: a CJS host (Node <20.19, no ESM require) must be able to load
 *  core. ESM stays the primary condition; this smoke-requires the built
 *  package through Node's own resolver (self-reference via `exports`). */
describe("CJS export condition", () => {
  it("require('@vendoai/core') and require('@vendoai/core/conformance') load the real surface", () => {
    const script = `
      const core = require("@vendoai/core");
      const conformance = require("@vendoai/core/conformance");
      if (typeof core.validateTreeV2 !== "function") throw new Error("validateTreeV2 missing");
      if (typeof core.VendoError !== "function") throw new Error("VendoError missing");
      if (core.VENDO_APPS_TOOL_PREFIX !== "vendo_apps_") throw new Error("constants missing");
      const parsed = core.runContextSchema.safeParse({
        principal: { kind: "user", subject: "u1" },
        venue: "chat", presence: "present", sessionId: "s1",
      });
      if (!parsed.success) throw new Error("schema parse failed under CJS");
      if (conformance.memoryStoreAdapter === undefined) throw new Error("conformance subpath missing");
      process.stdout.write("cjs-ok");
    `;
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    // --no-experimental-require-module models the CJS hosts this exists for
    // (Node without require(esm)) — the smoke must pass WITHOUT require(esm).
    const output = execFileSync(
      process.execPath,
      ["--no-experimental-require-module", "-e", script],
      { cwd: packageRoot, encoding: "utf8" },
    );
    expect(output).toBe("cjs-ok");
  });
});
