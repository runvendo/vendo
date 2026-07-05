/**
 * Bundles the sandbox runtime assets into the CLI dist so `vendo init` can
 * copy them into a host app's public/vendo/ without needing the monorepo:
 *  - the React shim (checked into @vendoai/stage's browser-test fixtures — the
 *    same file demo-bank ships), and
 *  - the catalog-only components sandbox bundle (built here via the
 *    @vendoai/components `build:sandbox` vite config).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(here, "..");
const root = resolve(cliDir, "../..");
const outDir = resolve(cliDir, "dist/assets");

const componentsBundle = resolve(root, "packages/vendo-components/dist-sandbox/vendo-components-sandbox.js");
if (!existsSync(componentsBundle)) {
  execFileSync("pnpm", ["--filter", "@vendoai/components", "build:sandbox"], { cwd: root, stdio: "inherit" });
}

mkdirSync(outDir, { recursive: true });
copyFileSync(componentsBundle, resolve(outDir, "vendo-components-sandbox.js"));
copyFileSync(
  resolve(root, "packages/vendo-stage/tests/browser/public/vendo-react-runtime.js"),
  resolve(outDir, "vendo-react-runtime.js"),
);
console.log("[vendo-cli] sandbox assets bundled into dist/assets/");
