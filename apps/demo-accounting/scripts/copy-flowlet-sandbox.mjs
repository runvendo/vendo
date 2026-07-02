/** Copies the sandbox host bundle + React shim into public/ so the client can
 *  fetch them as text and hand them to FlowletStage (bundleSource/reactSource).
 *  Unlike demo-bank (which ships the stock prewired bundle), the bundle here is
 *  the app-owned merged build from .flowlet/components — prewired catalog plus
 *  Cadence's registered host components. */
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const outDir = resolve(here, "../public/flowlet");
mkdirSync(outDir, { recursive: true });

copyFileSync(
  // flowletHostPreset names the artifact "host-bundle" (no extension).
  resolve(here, "../.flowlet/components/dist/host-bundle"),
  resolve(outDir, "components-sandbox.js"),
);
copyFileSync(
  resolve(root, "packages/flowlet-stage/tests/browser/public/flowlet-react-runtime.js"),
  resolve(outDir, "react-runtime.js"),
);
console.log("[flowlet] sandbox assets copied to public/flowlet/");
