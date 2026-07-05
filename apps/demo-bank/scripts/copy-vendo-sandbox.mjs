/** Copies the sandbox host bundle + React shim into public/ so the client can
 *  fetch them as text and hand them to VendoStage (bundleSource/reactSource). */
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const outDir = resolve(here, "../public/vendo");
mkdirSync(outDir, { recursive: true });

// Maple's OWN sandbox bundle (catalog + registered host components), built by
// vendo-sandbox/vite.config.ts. The public filename stays the same so
// SandboxStage needs no change.
copyFileSync(
  resolve(here, "../vendo-sandbox/dist/host-bundle"),
  resolve(outDir, "components-sandbox.js"),
);
copyFileSync(
  resolve(root, "packages/vendo-stage/tests/browser/public/vendo-react-runtime.js"),
  resolve(outDir, "react-runtime.js"),
);
console.log("[vendo] sandbox assets copied to public/vendo/");
