/**
 * Bundles the sandbox runtime assets into the CLI dist so `flowlet init` can
 * copy them into a host app's public/flowlet/ without needing the monorepo:
 *  - the React shim (checked into @flowlet/stage's browser-test fixtures — the
 *    same file demo-bank ships), and
 *  - the catalog-only components sandbox bundle (built here via the
 *    @flowlet/components `build:sandbox` vite config).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(here, "..");
const root = resolve(cliDir, "../..");
const outDir = resolve(cliDir, "dist/assets");

const componentsBundle = resolve(root, "packages/flowlet-components/dist-sandbox/flowlet-components-sandbox.js");
if (!existsSync(componentsBundle)) {
  execFileSync("pnpm", ["--filter", "@flowlet/components", "build:sandbox"], { cwd: root, stdio: "inherit" });
}

mkdirSync(outDir, { recursive: true });
copyFileSync(componentsBundle, resolve(outDir, "flowlet-components-sandbox.js"));
copyFileSync(
  resolve(root, "packages/flowlet-stage/tests/browser/public/flowlet-react-runtime.js"),
  resolve(outDir, "flowlet-react-runtime.js"),
);
console.log("[flowlet-cli] sandbox assets bundled into dist/assets/");
