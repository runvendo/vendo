/**
 * Copies the two sandbox runtime assets into public/vendo/ so both dev
 * servers can serve them (Vite from public/, server.mjs statically). This is
 * what `vendo init` does for a real host app; inside the monorepo we copy
 * from the source packages instead of the CLI's bundled dist/assets. They are
 * built output (~4.7 MB), so they're copied here, never checked in.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const outDir = resolve(here, "../public/vendo");

const shim = resolve(root, "packages/vendo-stage/tests/browser/public/vendo-react-runtime.js");
if (!existsSync(shim)) {
  execFileSync("pnpm", ["--filter", "@vendoai/stage", "build:react-shim"], { cwd: root, stdio: "inherit" });
}

const bundle = resolve(root, "packages/vendo-components/dist-sandbox/vendo-components-sandbox.js");
if (!existsSync(bundle)) {
  execFileSync("pnpm", ["--filter", "@vendoai/components", "build:sandbox"], { cwd: root, stdio: "inherit" });
}

mkdirSync(outDir, { recursive: true });
copyFileSync(shim, resolve(outDir, "react-runtime.js"));
copyFileSync(bundle, resolve(outDir, "components-sandbox.js"));
console.log("[vendo] sandbox assets copied to public/vendo/");
