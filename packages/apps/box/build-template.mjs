#!/usr/bin/env node
/**
 * execution-v2 Wave 3 (agent engine swapped Wave 8) — build the base box
 * template.
 *
 * The template bakes Node + the in-box agent harness (bootstrap.mjs +
 * harness.mjs) + the Claude Agent SDK (npm-installed into
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
import { copyFileSync, rmSync } from "node:fs";
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

// e2b resolves every copy() source against THIS SCRIPT's directory, and a
// source that climbs out of it fails the build before it starts (measured
// 2026-08-01: `../dist/...` → TemplateError; chdir does not move the base).
// The session-door files are therefore STAGED in beside the harness files and
// removed again below — build artifacts, and .gitignore says so. Both live in
// `@vendoai/harnesses` (the claude-code driver owns its box-side half): the
// runner is that package's compiled `dist/claude-code/claude-turn.js`, the
// session routes its shipped `box/turn-routes.mjs`. Run `pnpm build` before
// this script so harnesses' dist is current — the same precondition the
// `pnpm pack` of core and ui below already imposes.
process.chdir(here);
const STAGED_RUNNER = "claude-turn.mjs";
const STAGED_SESSION_ROUTES = "turn-routes.mjs";
const HARNESSES_DIR = path.join(here, "../../harnesses");

const cleanStaged = () => {
  rmSync(path.join(here, STAGED_RUNNER), { force: true });
  rmSync(path.join(here, STAGED_SESSION_ROUTES), { force: true });
};

cleanStaged();
// Stage the session-door files AFTER cleanStaged() — it removes them, so staging
// before the clean (as this script originally did) left the build with no
// claude-turn.mjs to copy.
copyFileSync(path.join(HARNESSES_DIR, "dist/claude-code/claude-turn.js"), path.join(here, STAGED_RUNNER));
copyFileSync(path.join(HARNESSES_DIR, "box/turn-routes.mjs"), path.join(here, STAGED_SESSION_ROUTES));

const template = Template()
  // The full node:22 image already ships curl + ca-certificates (the agent
  // curls its own endpoints to self-verify), so no apt step is needed.
  .fromImage("node:22-bookworm")
  // The sandbox runs as a non-root user, so create the dirs and land the
  // harness as root (the files stay world-readable for the start command).
  .runCmd("mkdir -p /app /app/.vendo /opt/vendo-box && chmod 777 /app /app/.vendo", { user: "root" })
  // The agent engine is the Claude Agent SDK, installed at BUILD time (the
  // template bake has full network; the running box does not). Both doors of
  // the control port resolve it from /opt/vendo-box/node_modules.
  .runCmd(
    `cd /opt/vendo-box && npm init -y >/dev/null && npm install --omit=dev @anthropic-ai/claude-agent-sdk@${AGENT_SDK_VERSION} && chmod -R a+rX /opt/vendo-box`,
    { user: "root" },
  )
  .copy("harness.mjs", "/opt/vendo-box/harness.mjs", { user: "root" })
  .copy("bootstrap.mjs", "/opt/vendo-box/bootstrap.mjs", { user: "root" })
  // The conversational turn door and the SDK loop behind it, both staged in
  // from `@vendoai/harnesses` above. `claude-turn.mjs` is the COMPILED
  // `packages/harnesses/src/claude-code/claude-turn.ts`, the same module
  // `machine: "local"` runs on the host and the same module BOTH doors of the
  // control port drive: one implementation, three callers.
  .copy(STAGED_SESSION_ROUTES, "/opt/vendo-box/turn-routes.mjs", { user: "root" })
  .copy(STAGED_RUNNER, "/opt/vendo-box/claude-turn.mjs", { user: "root" })
  // The materialized workspace's home. It is emptied and rewritten every turn,
  // so the SDK's session deliberately stays at its $HOME default — the snapshot
  // carries the whole disk either way.
  .runCmd("mkdir -p /workspace && chmod 777 /workspace", { user: "root" })
  .setWorkdir("/app")
  // The harness owns the control port and supervises the app process; readiness
  // is the control port coming up (the app has no code until an edit lands).
  .setStartCmd("node /opt/vendo-box/bootstrap.mjs", waitForPort(CONTROL_PORT));

let info;
try {
  info = await Template.build(template, name, { cpuCount: 1, memoryMB: 1024 });
} catch (error) {
  cleanStaged();
  console.error(`[vendo-box] build failed: ${error?.constructor?.name}: ${error?.message ?? error}`);
  for (const key of Object.keys(error ?? {})) {
    console.error(`  ${key}: ${JSON.stringify(error[key]).slice(0, 500)}`);
  }
  process.exit(1);
}

cleanStaged();

const id = info.templateId ?? info.aliases?.[0] ?? name;
console.log(`\n[vendo-box] built template: ${id}`);
console.log(`[vendo-box] set VENDO_BOX_TEMPLATE=${id} on the host to boot machines from it.`);
