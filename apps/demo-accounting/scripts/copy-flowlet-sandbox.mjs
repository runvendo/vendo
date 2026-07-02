/** Copies the sandbox host bundle + React shim into public/ so the client can
 *  fetch them as text and hand them to FlowletStage (bundleSource/reactSource).
 *  The bundle is Cadence's OWN build (flowlet-sandbox/entry.ts): the prewired
 *  catalog plus the app's registered host components. */
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const outDir = resolve(here, "../public/flowlet");
mkdirSync(outDir, { recursive: true });

copyFileSync(
  // flowletHostPreset names the artifact "host-bundle" (no extension).
  resolve(here, "../flowlet-sandbox/dist/host-bundle"),
  resolve(outDir, "components-sandbox.js"),
);
copyFileSync(
  resolve(root, "packages/flowlet-stage/tests/browser/public/flowlet-react-runtime.js"),
  resolve(outDir, "react-runtime.js"),
);
console.log("[flowlet] sandbox assets copied to public/flowlet/");
