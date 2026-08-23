#!/usr/bin/env node
/** Windows spawn gate — the enforcement half of "the repo runs on Windows".
 *
 *  Node has refused to exec a `.cmd`/`.bat` file without a shell since the fix
 *  for CVE-2024-27980 (Node 18.20.2 / 20.12.2 / 21.7.3). On Windows every
 *  package manager and every `node_modules/.bin/*` entry IS one of those shims,
 *  so `spawn("pnpm", …)` and `spawn(join(dir, "node_modules/.bin/next"), …)`
 *  fail with ENOENT before the child ever starts. That is not a Windows edge
 *  case in the product — it is the test suite, the fixtures and the box template
 *  refusing to run at all on a Windows checkout.
 *
 *  CI is ubuntu-only (every `runs-on:` in .github/workflows), which is exactly
 *  why this is a gate and not a test: nothing that runs on a green PR can
 *  observe the bug. This scan runs on Linux and fails there.
 *
 *  The two fixes it enforces:
 *    - a package manager → branch on the platform and give Windows ONE command
 *      STRING with `shell: true`. Not command + args array: that combination is
 *      DEP0190, and Node 24 prints the deprecation warning by default — a
 *      security warning about our own spawn, in the middle of `vendo` output.
 *    - a `node_modules/.bin/<tool>` entry → do not run the shim at all. Spawn
 *      `process.execPath` against the tool's real JS entry (`next/dist/bin/next`,
 *      `typescript/bin/tsc`): no shell, no quoting, one code path on both
 *      platforms. See fixtures/integration/src/global-setup.ts.
 *
 *  The check is per FILE, not per line, because a correct fix keeps the POSIX
 *  spawn verbatim in the else branch — a line-level scan would flag the fix it
 *  is asking for. A file that spawns one of these and never names `win32` has
 *  not been through this; a file that does is taken at its word.
 *
 *  Run: node scripts/windows-spawn-gate.mjs  (wired into `pnpm lint`). */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Where source that has to run on a contributor's machine lives. */
const SCANNED = ["packages", "fixtures", "corpus", "examples", "scripts", "genbench"];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", ".turbo", "coverage", ".vendo"]);

/** Known and deliberate, each with the reason it is not simply fixed. Kept as
 *  an explicit list rather than a narrower scan so that skipping something
 *  stays visible in review. */
const ALLOWED = new Map([
  [
    "genbench/src/codex.ts",
    "codex is a NATIVE binary published through npm — it has no JS entry to run on process.execPath, " +
      "so the shim is the only entry point and the fix is a different one. genbench is an on-demand " +
      "benchmark, never part of `pnpm test`.",
  ],
]);

const PACKAGE_MANAGER_SPAWN = /spawn(?:Sync)?\s*\(\s*["'](?:npm|pnpm|npx|yarn|bun)["']\s*,\s*\[/;
const DOT_BIN_PATH = /["']node_modules["']\s*,\s*["']\.bin["']|node_modules\/\.bin\//;
const ANY_SPAWN = /\bspawn(?:Sync)?\s*\(/;
const HAS_PLATFORM_BRANCH = /win32/;

/** Comments carry the explanation of the very patterns banned here, so they are
 *  removed before matching — otherwise every correct fix flags itself. Strings
 *  are left alone: a path built in a string IS the hazard. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

async function* sourceFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // an optional tree (fixtures a shallow clone skipped) is not a failure
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|tsx|mts|js|mjs|cjs)$/.test(entry.name)) yield path;
  }
}

const failures = [];
let scanned = 0;

for (const tree of SCANNED) {
  for await (const file of sourceFiles(join(root, tree))) {
    const rel = relative(root, file).split(sep).join("/");
    if (rel === "scripts/windows-spawn-gate.mjs" || ALLOWED.has(rel)) continue;
    scanned += 1;
    const code = stripComments(await readFile(file, "utf8"));
    if (HAS_PLATFORM_BRANCH.test(code)) continue;
    if (PACKAGE_MANAGER_SPAWN.test(code)) {
      failures.push([rel, 'spawns a package manager with no `win32` branch — it is a .cmd shim there and ENOENTs without a shell. Give Windows ONE command string with `shell: true`.']);
    }
    if (DOT_BIN_PATH.test(code) && ANY_SPAWN.test(code)) {
      failures.push([rel, "spawns a node_modules/.bin/* entry — extensionless on POSIX, a .cmd/.ps1 pair on Windows. Spawn process.execPath against the tool's real JS entry instead."]);
    }
  }
}

for (const [file, message] of failures) console.error(`windows-spawn-gate: ${file} — ${message}`);
if (failures.length > 0) {
  console.error(`\nwindows-spawn-gate: ${failures.length} file${failures.length === 1 ? "" : "s"} of ${scanned} scanned.`);
  process.exit(1);
}
console.log(`windows-spawn-gate: ok (${scanned} files, ${ALLOWED.size} documented exception${ALLOWED.size === 1 ? "" : "s"})`);
