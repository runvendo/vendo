/** Copies the sandbox host bundle + React shim into public/ so the client can
 *  fetch them as text and hand them to FlowletStage (bundleSource/reactSource). */
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const outDir = resolve(here, "../public/flowlet");
mkdirSync(outDir, { recursive: true });

// The clone's OWN sandbox bundle (catalog + registered host components).
copyFileSync(
  resolve(here, "../flowlet-sandbox/dist/host-bundle"),
  resolve(outDir, "components-sandbox.js"),
);
copyFileSync(
  resolve(root, "packages/flowlet-stage/tests/browser/public/flowlet-react-runtime.js"),
  resolve(outDir, "react-runtime.js"),
);
console.log("[flowlet] sandbox assets copied to public/flowlet/");
