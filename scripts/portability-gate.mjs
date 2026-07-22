#!/usr/bin/env node
/** Portability gate — the enforcement half of the edge-portability contract
 *  (docs/superpowers/plans/2026-07-21-edge-portability.md; field origin:
 *  vendo-on-Cloudflare-Workers, Mohamed/digger.dev, 2026-07-21).
 *
 *  Leg A (bundle): the server entry must bundle for a Worker target with no
 *    unresolved imports and none of the known Node-only legs in the graph
 *    (CLI, dev-creds ladder, actions sync, telemetry disk config, store
 *    engines). Bare node builtins stay external — that mirrors Wrangler's
 *    nodejs_compat, the Workers baseline.
 *  Leg B (boot): the fixture worker constructs createVendo at MODULE SCOPE
 *    under real workerd and must serve GET /status 200 — catching
 *    global-scope I/O and timers, unbound fetch, and anything a bundle
 *    check can't see.
 *  Leg C (source): the raw hazard patterns must not reappear in source.
 *
 *  Run: node scripts/portability-gate.mjs  (wired into `pnpm lint`). */
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const SERVER_ENTRY = join(root, "packages/vendo/dist/server.js");
const { existsSync } = await import("node:fs");
if (!existsSync(SERVER_ENTRY)) {
  console.error("portability-gate: packages/vendo/dist/server.js missing — run `pnpm build` first");
  process.exit(1);
}
const FIXTURE_ENTRY = join(root, "scripts/fixtures/portability-worker/worker.mjs");

/** Wrangler's nodejs_compat provides these; anything else must resolve. */
const NODE_BUILTIN_EXTERNALS = [
  "node:*", "assert", "buffer", "child_process", "crypto", "dns", "events", "fs", "fs/promises",
  "http", "https", "module", "net", "os", "path", "process", "stream", "stream/promises",
  "string_decoder", "tls", "tty", "url", "util", "util/types", "worker_threads", "zlib",
];

/** Node-only legs that must NEVER be reachable from the worker-condition
 *  server graph. Each entry names the containment seam that keeps it out. */
const FORBIDDEN_INPUTS = [
  { fragment: "packages/vendo/dist/cli/", seam: "cloud-key-fetch.ts (runtime code must not borrow CLI modules)" },
  { fragment: "packages/vendo/dist/dev-creds/model.js", seam: "#dev-creds/model conditions" },
  { fragment: "packages/actions/dist/sync/", seam: "@vendoai/actions/sync subpath split" },
  { fragment: "packages/actions/dist/runtime/host-files.js", seam: "#actions/host-files conditions" },
  { fragment: "packages/vendo-telemetry/dist/config.js", seam: "@vendoai/telemetry worker conditions" },
  { fragment: "packages/vendo-telemetry/dist/base-props.js", seam: "@vendoai/telemetry worker conditions" },
  { fragment: "packages/store/dist/db.js", seam: "#store/db conditions" },
  { fragment: "packages/store/dist/crypto.js", seam: "#store/crypto conditions" },
  { fragment: "node_modules/.pnpm/pg@", seam: "#store/db conditions" },
  { fragment: "node_modules/.pnpm/typescript@", seam: "@vendoai/actions/sync subpath split" },
  { fragment: "node_modules/.pnpm/e2b@", seam: "bundler-blind e2b specifier (apps/src/e2b)" },
];

/** Raw source patterns whose fix classes this gate owns. */
const SOURCE_GUARDS = [
  {
    pattern: /\?\?\s*globalThis\.fetch\b/,
    message: "detached `?? globalThis.fetch` default (Illegal invocation on Workers) — use defaultFetch from @vendoai/core",
  },
  {
    pattern: /await import\((?:\/\*[^*]*\*\/\s*)*["']e2b["']\)/,
    message: "literal import(\"e2b\") — esbuild hard-resolves it; route through the bundler-blind specifier in packages/apps/src/e2b",
  },
];

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`portability-gate: BROKEN — ${message}`);
};
const ok = (message) => console.log(`portability-gate: ok — ${message}`);

// ---- Leg A: worker-condition bundle of the server entry ----
const esbuild = require("esbuild");
async function bundle(entry, outAs) {
  return await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker"],
    mainFields: ["module", "main"],
    external: NODE_BUILTIN_EXTERNALS,
    // scripts/ is not a workspace package; the fixture's umbrella import
    // resolves straight to the built entry.
    alias: { "@vendoai/vendo/server": SERVER_ENTRY },
    metafile: true,
    write: outAs !== undefined,
    outfile: outAs,
    logLevel: "silent",
  });
}

let serverMeta;
try {
  const result = await bundle(SERVER_ENTRY);
  serverMeta = result.metafile;
  ok("server entry bundles for a Worker target with zero unresolved imports");
} catch (error) {
  const messages = (error.errors ?? []).slice(0, 8).map((e) => `\n    ${e.text} (${e.location?.file ?? "?"})`).join("");
  fail(`server entry does not bundle for a Worker target:${messages || `\n    ${error.message}`}`);
}

if (serverMeta !== undefined) {
  const inputs = Object.keys(serverMeta.inputs);
  for (const { fragment, seam } of FORBIDDEN_INPUTS) {
    const hit = inputs.find((input) => input.includes(fragment));
    if (hit === undefined) continue;
    fail(`Node-only leg reached the worker server graph: ${hit}\n    containment seam: ${seam}`);
  }
  if (!inputs.some((input) => FORBIDDEN_INPUTS.some(({ fragment }) => input.includes(fragment)))) {
    ok(`no Node-only leg in the worker server graph (${inputs.length} modules checked)`);
  }
}

// ---- Leg C: raw hazard patterns in source ----
async function* sourceFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.test\./.test(entry.name)) yield path;
  }
}

let guardHits = 0;
for await (const file of sourceFiles(join(root, "packages"))) {
  const source = await readFile(file, "utf8");
  for (const { pattern, message } of SOURCE_GUARDS) {
    if (!pattern.test(source)) continue;
    guardHits += 1;
    fail(`${file.replace(`${root}/`, "")}: ${message}`);
  }
}
if (guardHits === 0) ok("no raw hazard patterns in package sources");

// ---- Leg B: module-scope boot + /status under real workerd ----
try {
  const fixture = await bundle(FIXTURE_ENTRY, join(root, "scripts/fixtures/portability-worker/.bundle.mjs"));
  void fixture;
  const bundled = await readFile(join(root, "scripts/fixtures/portability-worker/.bundle.mjs"), "utf8");
  const { Miniflare } = await import("miniflare");
  // Explicit modules array: miniflare's automatic locator statically scans
  // for import() and rejects non-literal specifiers (our bundler-blind e2b
  // import); the explicit form defers that to workerd's runtime, where the
  // optional load correctly fails only when invoked.
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: bundled }],
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
  });
  try {
    const response = await mf.dispatchFetch("https://portability.gate/api/vendo/status");
    const body = await response.text();
    if (response.status === 200) ok("fixture worker constructed createVendo at module scope and served /status 200 under workerd");
    else fail(`fixture worker /status answered ${response.status}: ${body.slice(0, 300)}`);
  } finally {
    await mf.dispose();
  }
} catch (error) {
  fail(`fixture worker did not boot under workerd: ${error instanceof Error ? error.message : String(error)}`);
}

if (failures > 0) {
  console.error(`portability-gate: ${failures} failure(s)`);
  process.exit(1);
}
console.log("portability-gate: all legs green");
