/**
 * test:browser pre-step: copy the freshly built REAL @vendoai/components
 * sandbox bundle into the gate server's public dir so gate-real-bundle runs
 * against the artifact demo-bank actually ships (not a sample bundle).
 */
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(
  new URL("../../../vendo-components/dist-sandbox/vendo-components-sandbox.js", import.meta.url),
);
const dest = fileURLToPath(new URL("./public/components-sandbox.js", import.meta.url));

copyFileSync(src, dest);
console.log(`[vendo-stage] real components bundle copied to ${dest}`);
