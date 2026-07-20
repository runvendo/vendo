#!/usr/bin/env node
/**
 * execution-v2 Wave 3 (agent engine swapped Wave 8) — build the base box
 * template.
 *
 * The template bakes Node + the in-box agent harness (bootstrap.mjs +
 * harness.mjs + agent-sdk.mjs) + the Claude Agent SDK (npm-installed into
 * /opt/vendo-box at BUILD time — install size is a template concern, never a
 * wake concern) and a curl toolbelt into a reproducible e2b template. Its
 * start command runs the harness, which serves the control port (8811) and
 * supervises the app the in-box agent writes under /app.
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
// The in-box agent engine (Wave 8): Claude Code as a library, pinned so the
// template is reproducible. npm auto-installs its peers (zod, the Anthropic
// SDK, the MCP SDK).
const AGENT_SDK_VERSION = "0.3.215";
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
  // Wave 8 — the agent engine is the Claude Agent SDK, installed at BUILD
  // time (the template bake has full network; the running box does not).
  // agent-sdk.mjs resolves it from /opt/vendo-box/node_modules.
  .runCmd(
    `cd /opt/vendo-box && npm init -y >/dev/null && npm install --omit=dev @anthropic-ai/claude-agent-sdk@${AGENT_SDK_VERSION} && chmod -R a+rX /opt/vendo-box`,
    { user: "root" },
  )
  .copy("harness.mjs", "/opt/vendo-box/harness.mjs", { user: "root" })
  .copy("agent-sdk.mjs", "/opt/vendo-box/agent-sdk.mjs", { user: "root" })
  .copy("bootstrap.mjs", "/opt/vendo-box/bootstrap.mjs", { user: "root" })
  // Wave 7 H2 — the pre-baked served-app scaffold: a layer-3 build starts
  // warm by copying it into /app and EDITING (skin-contract plumbing —
  // /fn envelopes, vendo.json, theme handoff — already wired and
  // conformance-tested in box-scaffold.test.ts). Zero-dependency by design,
  // so there is no node_modules to bake.
  .copy("scaffold/package.json", "/opt/vendo-box/scaffold/package.json", { user: "root" })
  .copy("scaffold/server.js", "/opt/vendo-box/scaffold/server.js", { user: "root" })
  .copy("scaffold/fns.js", "/opt/vendo-box/scaffold/fns.js", { user: "root" })
  .copy("scaffold/index.html", "/opt/vendo-box/scaffold/index.html", { user: "root" })
  .copy("scaffold/vendo.json", "/opt/vendo-box/scaffold/vendo.json", { user: "root" })
  // The Procfile entry lands under .vendo/ so one `cp -a scaffold/. /app/`
  // arms the supervisor too.
  .copy("scaffold/run", "/opt/vendo-box/scaffold/.vendo/run", { user: "root" })
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
