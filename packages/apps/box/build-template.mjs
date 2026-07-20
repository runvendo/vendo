#!/usr/bin/env node
/**
 * execution-v2 Wave 3 — build the base box template.
 *
 * The template bakes Node + the in-box agent harness (bootstrap.mjs +
 * harness.mjs + agent-loop.mjs) and a curl toolbelt into a reproducible e2b
 * template. Its start command runs the harness, which serves the control port
 * (8811) and supervises the app the in-box agent writes under /app.
 *
 *   node build-template.mjs [name]
 *
 * Requires E2B_API_KEY in the environment. Prints the built template id; set it
 * as VENDO_BOX_TEMPLATE on the host so machine provisioning boots from it. This
 * is the reproducible recipe — re-run it to rebuild the base snapshot.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { Template, waitForPort } from "e2b";

const CONTROL_PORT = 8811;
const here = path.dirname(fileURLToPath(import.meta.url));
const name = process.argv[2] ?? "vendo-box";

// e2b's build context is the current working directory and copy() sources must
// be RELATIVE to it — run this script from packages/apps/box so the three
// harness files resolve.
process.chdir(here);

const template = Template()
  // The full node:22 image already ships curl + ca-certificates (the agent
  // curls its own endpoints to self-verify), so no apt step is needed.
  .fromImage("node:22-bookworm")
  // The sandbox runs as a non-root user, so create the dirs and land the
  // harness as root (the files stay world-readable for the start command).
  .runCmd("mkdir -p /app /app/.vendo /opt/vendo-box && chmod 777 /app /app/.vendo", { user: "root" })
  .copy("harness.mjs", "/opt/vendo-box/harness.mjs", { user: "root" })
  .copy("agent-loop.mjs", "/opt/vendo-box/agent-loop.mjs", { user: "root" })
  .copy("bootstrap.mjs", "/opt/vendo-box/bootstrap.mjs", { user: "root" })
  .setWorkdir("/app")
  // The harness owns the control port and supervises the app process; readiness
  // is the control port coming up (the app has no code until an edit lands).
  .setStartCmd("node /opt/vendo-box/bootstrap.mjs", waitForPort(CONTROL_PORT));

let info;
try {
  info = await Template.build(template, name, { cpuCount: 1, memoryMB: 1024 });
} catch (error) {
  console.error(`[vendo-box] build failed: ${error?.constructor?.name}: ${error?.message ?? error}`);
  for (const key of Object.keys(error ?? {})) {
    console.error(`  ${key}: ${JSON.stringify(error[key]).slice(0, 500)}`);
  }
  process.exit(1);
}

const id = info.templateId ?? info.aliases?.[0] ?? name;
console.log(`\n[vendo-box] built template: ${id}`);
console.log(`[vendo-box] set VENDO_BOX_TEMPLATE=${id} on the host to boot machines from it.`);
