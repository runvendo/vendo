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
import { cpSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

/** Where the app template's deps are installed ONCE, in the image. */
const DEPS_DIR = "/opt/vendo-box/deps";
/** Where the app template itself lands; `cp -a` of this is a warm start. */
const TEMPLATE_DIR = "/opt/vendo-box/template";
/** Where the packed workspace tarballs land. */
const PKG_DIR = "/opt/vendo-box/pkg";

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

// ─── the app template, staged in for the same e2b reason ─────────────────────
//
// `packages/box-template` is a real workspace package, so a developer's own
// `pnpm install` gives it resolvable deps and it typechecks, builds and runs in
// the monorepo. It cannot LIVE under packages/apps: the dependency guard scans a
// package's whole directory, and an app template importing @vendoai/ui/kit inside
// packages/apps would (correctly) violate `apps → core`.
const STAGED_TEMPLATE = "template";
const STAGED_PKG = "pkg";
const SOURCE_TEMPLATE = path.join(here, "../../box-template");
const stagedTemplate = path.join(here, STAGED_TEMPLATE);
const stagedPkg = path.join(here, STAGED_PKG);
const cleanStaged = () => {
  rmSync(path.join(here, STAGED_RUNNER), { force: true });
  rmSync(path.join(here, STAGED_SESSION_ROUTES), { force: true });
  rmSync(stagedTemplate, { recursive: true, force: true });
  rmSync(stagedPkg, { recursive: true, force: true });
};

cleanStaged();
// Stage the session-door files AFTER cleanStaged() — it removes them, so staging
// before the clean (as this script originally did) left the build with no
// claude-turn.mjs to copy.
copyFileSync(path.join(HARNESSES_DIR, "dist/claude-code/claude-turn.js"), path.join(here, STAGED_RUNNER));
copyFileSync(path.join(HARNESSES_DIR, "box/turn-routes.mjs"), path.join(here, STAGED_SESSION_ROUTES));
const skipped = new Set(["node_modules", "dist", "package-lock.json"]);
cpSync(SOURCE_TEMPLATE, stagedTemplate, {
  recursive: true,
  filter: (source) => {
    const rel = path.relative(SOURCE_TEMPLATE, source);
    return rel === "" || !skipped.has(rel.split(path.sep)[0]);
  },
});
// The Procfile entry lands under .vendo/ so one `cp -a template/. /app/` arms
// the supervisor too.
mkdirSync(path.join(stagedTemplate, ".vendo"), { recursive: true });
copyFileSync(path.join(stagedTemplate, "run"), path.join(stagedTemplate, ".vendo", "run"));
rmSync(path.join(stagedTemplate, "run"));

// The running box has NO registry egress, so every @vendoai/* the template needs
// must be materialized at bake time. `pnpm pack` each workspace package from
// THIS commit — reproducible from the monorepo, with zero publish dependency.
// (`pnpm build` must have run: pack ships only `files`, i.e. dist/.)
mkdirSync(stagedPkg, { recursive: true });
const WORKSPACE_PACKAGES = ["core", "ui"];
const tarballs = {};
for (const workspacePackage of WORKSPACE_PACKAGES) {
  const packed = spawnSync("pnpm", ["pack", "--pack-destination", stagedPkg], {
    cwd: path.join(here, "../..", workspacePackage),
    encoding: "utf8",
  });
  if (packed.status !== 0) {
    cleanStaged();
    console.error(`[vendo-box] pnpm pack failed for @vendoai/${workspacePackage}: ${packed.stderr}`);
    process.exit(1);
  }
  // Stable names, so the manifests below need no version in them.
  const produced = readdirSync(stagedPkg).find((file) => file.startsWith(`vendoai-${workspacePackage}-`));
  const stable = `vendoai-${workspacePackage}.tgz`;
  copyFileSync(path.join(stagedPkg, produced), path.join(stagedPkg, stable));
  rmSync(path.join(stagedPkg, produced));
  tarballs[`@vendoai/${workspacePackage}`] = `file:${PKG_DIR}/${stable}`;
}

// A PACKED workspace package declares its siblings by REGISTRY range (pnpm
// rewrites `workspace:*` to the real version on pack), and those versions are
// published — so a plain install would resolve @vendoai/ui from npm and silently
// shadow the local build. `overrides` forces every resolution, transitive ones
// included, to the tarball from this commit.
const manifest = JSON.parse(readFileSync(path.join(stagedTemplate, "package.json"), "utf8"));
for (const [dependency, specifier] of Object.entries(tarballs)) {
  if (manifest.dependencies?.[dependency] !== undefined) manifest.dependencies[dependency] = specifier;
}
manifest.overrides = { ...manifest.overrides, ...tarballs };
writeFileSync(path.join(stagedTemplate, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

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
  // The universal app template (blueprint §11): Vite + React 19 with the Kit
  // preinstalled. A build starts warm by copying it into /app and EDITING —
  // the skin contract (/fn envelopes, vendo.json, the .vendo/run entry) is
  // already wired and conformance-tested in apps/src/box-template.test.ts.
  //
  // ONE universal template, baked once per Vendo release. Nothing
  // company-specific is ever baked: the host's brand and the host's own
  // components arrive as FILES under /app/.vendo/host/ at provision time
  // (packages/box-template/provision.mjs is the receiving end).
  .copy(`${STAGED_PKG}/`, `${PKG_DIR}/`, { user: "root" })
  .copy(`${STAGED_TEMPLATE}/`, `${TEMPLATE_DIR}/`, { user: "root" })
  // Install the template's deps ONCE, into the image, and leave the template's
  // own node_modules as a SYMLINK to them. Two reasons, both measured concerns:
  // the bake has full network and the running box has none, so this is the only
  // moment an install can happen; and `cp -a template/. /app/` then copies a
  // link instead of a few hundred megabytes on every single build.
  .runCmd(
    [
      `mkdir -p ${DEPS_DIR}`,
      `cp ${TEMPLATE_DIR}/package.json ${DEPS_DIR}/package.json`,
      `cd ${DEPS_DIR} && npm install --no-audit --no-fund`,
      `ln -s ${DEPS_DIR}/node_modules ${TEMPLATE_DIR}/node_modules`,
      "chmod -R a+rX /opt/vendo-box",
    ].join(" && "),
    { user: "root" },
  )
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
