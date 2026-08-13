#!/usr/bin/env node
/** Portability gate — the enforcement half of the edge-portability contract
 *  (2026-07-21 edge-portability plan, archived in the private repo; field
 *  origin: vendo-on-Cloudflare-Workers, Mohamed/digger.dev, 2026-07-21).
 *
 *  Leg A (bundle): the server entry must bundle for a Worker target with no
 *    unresolved imports and none of the known Node-only legs in the graph
 *    (CLI, dev-creds ladder, actions sync, telemetry disk config, store
 *    engines). Bare node builtins stay external — that mirrors Wrangler's
 *    nodejs_compat, the Workers baseline.
 *  Leg A2 (store split): the @vendoai/store/postgres entry must bundle under
 *    DEFAULT/node resolution (what OpenNext-style Worker builds and Lambda
 *    bundlers use — the resolution mode under which a console Worker silently
 *    crossed Cloudflare's size ceiling carrying PGlite wasm it can't run)
 *    with neither PGlite nor the store's PGlite engine module in the graph.
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
  { fragment: "node_modules/.pnpm/e2b@", seam: "bundler-blind e2b specifier (apps/src/server/escalation/e2b)" },
  { fragment: "node_modules/.pnpm/esbuild@", seam: "bundler-blind esbuild specifier (apps/src/server/checking/islands)" },
  { fragment: "packages/apps/dist/server/edge/", seam: "@vendoai/apps/edge subpath split (a whole TypeScript compiler, for the venue that has no Node — a Node host must never carry it)" },
];

/** Raw source patterns whose fix classes this gate owns. */
const SOURCE_GUARDS = [
  {
    pattern: /\?\?\s*globalThis\.fetch\b/,
    message: "detached `?? globalThis.fetch` default (Illegal invocation on Workers) — use defaultFetch from @vendoai/core",
  },
  {
    pattern: /await import\((?:\/\*[^*]*\*\/\s*)*["']e2b["']\)/,
    message: "literal import(\"e2b\") — esbuild hard-resolves it; route through the bundler-blind specifier in packages/apps/src/server/escalation/e2b",
  },
  {
    pattern: /await import\((?:\/\*[^*]*\*\/\s*)*["']esbuild["']\)/,
    message: "literal import(\"esbuild\") — Wrangler inlines the Node-only package into Worker bundles (island validator field failure); use the mutable-specifier pattern",
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

// ---- Leg A2: @vendoai/store/postgres stays PGlite-free under node resolution ----
const STORE_POSTGRES_ENTRY = join(root, "packages/store/dist/postgres.js");
if (!existsSync(STORE_POSTGRES_ENTRY)) {
  fail("packages/store/dist/postgres.js missing — run `pnpm build` first");
} else {
  try {
    const result = await esbuild.build({
      entryPoints: [STORE_POSTGRES_ENTRY],
      bundle: true,
      format: "esm",
      platform: "node",
      external: ["pg-native"],
      metafile: true,
      write: false,
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs);
    const leaks = inputs.filter(
      (input) => input.includes("@electric-sql") || input.includes("pglite") || input.includes("packages/store/dist/db.js"),
    );
    if (leaks.length > 0) {
      fail(`@vendoai/store/postgres reached the PGlite engine under node resolution: ${leaks[0]}\n    containment seam: packages/store src/db-postgres.ts split (engine picker stays in src/db.ts)`);
    } else {
      ok(`store postgres entry stays PGlite-free under node resolution (${inputs.length} modules checked)`);
    }
  } catch (error) {
    const messages = (error.errors ?? []).slice(0, 8).map((e) => `\n    ${e.text} (${e.location?.file ?? "?"})`).join("");
    fail(`store postgres entry does not bundle under node resolution:${messages || `\n    ${error.message}`}`);
  }
}

// ---- Leg A3: @vendoai/harnesses bundles for a Worker target ----
// Its own leg because the harness runtime is NOT yet imported by the server
// entry (composition wires it at integration), so Leg A would pass vacuously
// while the package rotted. The runtime does use `node:async_hooks`
// (AsyncLocalStorage, to attribute a subagent hire to the right concurrent
// turn), which nodejs_compat provides and NODE_BUILTIN_EXTERNALS allows —
// this leg is what keeps that true.
const HARNESSES_ENTRY = join(root, "packages/harnesses/dist/index.js");
if (!existsSync(HARNESSES_ENTRY)) {
  fail("packages/harnesses/dist/index.js missing — run `pnpm build` first");
} else {
  try {
    const result = await bundle(HARNESSES_ENTRY);
    const inputs = Object.keys(result.metafile.inputs);
    const hit = inputs.find((input) => FORBIDDEN_INPUTS.some(({ fragment }) => input.includes(fragment)));
    if (hit !== undefined) {
      const { seam } = FORBIDDEN_INPUTS.find(({ fragment }) => hit.includes(fragment));
      fail(`Node-only leg reached the harness runtime graph: ${hit}\n    containment seam: ${seam}`);
    } else {
      ok(`@vendoai/harnesses bundles for a Worker target (${inputs.length} modules checked)`);
    }
  } catch (error) {
    const messages = (error.errors ?? []).slice(0, 8).map((e) => `\n    ${e.text} (${e.location?.file ?? "?"})`).join("");
    fail(`@vendoai/harnesses does not bundle for a Worker target:${messages || `\n    ${error.message}`}`);
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

// ---- Leg D: the app-generation CONTRACT door bundles for a BROWSER ----
// `@vendoai/apps/contract` is the browser-safe half of the app engine, and
// `scripts/dependency-guard.mjs`'s ONLY_SUBPATHS rule makes it the one door
// @vendoai/ui may reach. That rule enforces which SPECIFIER ui writes; nothing
// enforced what the specifier RESOLVES to. A single `import "node:fs"` inside
// src/contract/ passed lint, typecheck and the whole suite, and surfaced only
// in a customer's `next build` — so the headline layering claim was a
// convention, not a mechanism. This is the mechanism.
try {
  await esbuild.build({
    entryPoints: [join(root, "packages/apps/dist/contract/index.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  ok("@vendoai/apps/contract bundles for a browser target (no node built-ins)");
} catch (error) {
  fail(
    "@vendoai/apps/contract does NOT bundle for a browser target — something under "
    + "packages/apps/src/contract/ reached a node built-in or a node-only package. "
    + "That door is imported by @vendoai/ui and by browser consumers; it must stay "
    + `platform-clean. ${error instanceof Error ? error.message : String(error)}`,
  );
}

// ---- Leg E: the edge screen toolchain, in workerd, with NO nodejs_compat ----
// `@vendoai/apps/edge` exists so a screen can be checked where there is no Node,
// and every test it has runs under Node — which proves the three machines agree
// with the stock ones, and nothing at all about the venue they were written for.
// This leg is the venue: the toolchain bundled for workerd and driven through
// compile, type-check and RUN inside a real isolate.
//
// `compatibilityFlags: []` is the whole point and is not tunable. The production
// checker Worker ships with `compatibility_flags = []` because TypeScript BREAKS
// under nodejs_compat: `isNodeLikeSystem()` reads the `process` the flag
// installs, takes its Node branch, and reaches for `fs` and `__filename` at
// module scope. Turning the flag on here to make an import resolve would trade
// this leg's failure for a failure in production.
//
// It asserts THREE things, because the first run proved no subset of them is
// enough. A REQUIRE and an IMPORT of the same module are not the same hazard,
// and the leg is built around that asymmetry:
//
//   (a) `checking/screen-tsc.js` is not in the bundle's module graph. That file
//       is the Node-only half of the screen compiler — the one that resolves
//       `typescript` through `createRequire`. The edge leg type-checks through
//       `checking/screen-program.js`, which imports no builtin. Absence from the
//       graph is the invariant itself, and it is cheaper and sharper than any
//       assertion about the emitted text.
//   (b) the bundle builds with NO `node:*` external whatsoever, so a `node:`
//       specifier in ANY position fails the build rather than surviving as an
//       external the way it did on this leg's first run.
//   (c) it then RUNS, and paints real text.
//
// (a) and (b) are cheap and precise; (c) is the ground truth, and no two of the
// three replace the third.
//
// (a) IS NOT REDUNDANT, and a future reader trimming it needs the real reason.
// esbuild records a module in `metafile.inputs` even when it drops that module's
// code from the OUTPUT: with `sideEffects: false`, an import whose bindings go
// unused is tree-shaken away, and the module's `node:` import goes with it. So
// there is a class of module that (a) can see and (b) and (c) provably cannot —
// a Node-only module in the edge graph whose builtin import has been shaken out
// of the emitted bundle. The build resolves, the worker starts, the screen
// paints, and the module is in the graph the whole time.
//
// That class is LATENT, not live. It is one refactor from becoming the real
// defect: the moment anything actually uses a binding from that module, the
// import comes back and stops the worker at startup. (a) is what sees it while
// it is still latent, because it does not ask what the bundle DID — it asks what
// is IN it.
const EDGE_ENTRY = join(root, "packages/apps/dist/server/edge/index.js");
const EDGE_FIXTURE_ENTRY = join(root, "scripts/fixtures/edge-checker-worker/worker.mjs");
const NODE_COMPILER_LOADER = "packages/apps/dist/server/checking/screen-tsc.js";

// A path fragment that matches nothing matches nothing SILENTLY: rename or move
// that file and (a) keeps passing with the guard gone and no one told. So the
// fragment must resolve to a real file before it is allowed to prove anything.
const loaderPathIsReal = existsSync(join(root, NODE_COMPILER_LOADER));
if (!loaderPathIsReal) {
  fail(
    `assertion (a) names a file that does not exist: ${NODE_COMPILER_LOADER}\n`
    + "    This guard checks that the Node-only compiler loader is ABSENT from the edge\n"
    + "    bundle, so a fragment that can never match would leave the leg green and empty.\n"
    + "    If that module was renamed or moved, point NODE_COMPILER_LOADER at its new path\n"
    + "    — do not delete the assertion.",
  );
}

/**
 * TypeScript's own `getNodeSystem()` reaches for `fs`, `path`, `os`,
 * `inspector` and `source-map-support` (typescript/lib/typescript.js:8273-8275,
 * :8384, :8424). Those are CommonJS `require()` CALLS, and a call is not an
 * import: a bundler leaves it as a `__require` shim that throws when it is
 * INVOKED, `isNodeLikeSystem()` is false without nodejs_compat, so nothing ever
 * invokes it. An ESM `import` of the same module is resolved while workerd
 * instantiates the module graph and stops the worker before a handler runs.
 * That asymmetry is the whole reason this bundle permits no `node:*` external:
 * conflating the two sends the next person chasing a require that cannot hurt
 * them, past the import that can.
 *
 * So the two forms are treated differently rather than both excused. A require
 * call gets an empty module; an ESM import of these same names is left to fail
 * resolution, exactly as a `node:` specifier does.
 */
const GET_NODE_SYSTEM_REQUIRES = /^(fs|path|os|inspector|source-map-support)$/;
const stubDeadRequires = {
  name: "stub-dead-requires",
  setup(build) {
    build.onResolve({ filter: GET_NODE_SYSTEM_REQUIRES }, (args) =>
      (args.kind === "require-call" ? { path: args.path, namespace: "gate-stub" } : undefined));
    build.onLoad({ filter: /.*/, namespace: "gate-stub" }, () => ({ contents: "module.exports = {};", loader: "js" }));
  },
};

if (!existsSync(EDGE_ENTRY)) {
  fail("packages/apps/dist/server/edge/index.js missing — run `pnpm build` first");
} else {
  try {
    const appsRequire = createRequire(join(root, "packages/apps/package.json"));
    const bundled = await esbuild.build({
      entryPoints: [EDGE_FIXTURE_ENTRY],
      bundle: true,
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "worker"],
      mainFields: ["module", "main"],
      // The wasm alone, and it is not a concession: the fixture's
      // `./quickjs.wasm` is the module the DEPLOYMENT imports, supplied by the
      // modules array below. Every other specifier must resolve.
      external: ["*.wasm"],
      plugins: [stubDeadRequires],
      alias: {
        // scripts/ is not a workspace package (Leg A's reason), and the bare
        // `typescript` here is the repo's 5.x build compiler; the edge leg's
        // peer is pinned to the 6.0.3 its vendored lib files were copied from,
        // installed as `typescript-6`. Same alias, same reason, as
        // packages/apps/vitest.config.ts.
        "@vendoai/apps/edge": EDGE_ENTRY,
        typescript: appsRequire.resolve("typescript-6"),
      },
      metafile: true,
      write: false,
      logLevel: "silent",
    });
    const loader = Object.keys(bundled.metafile.inputs).find((input) => input.includes(NODE_COMPILER_LOADER));
    if (loader !== undefined) {
      fail(
        `the Node-only compiler loader reached the edge bundle: ${loader}\n`
        + "    containment seam: checking/screen-program.ts holds the portable program builder;\n"
        + "    screen-tsc.ts keeps the `node:module` half and bridges to it with no re-export",
      );
    }
    const { Miniflare } = await import("miniflare");
    const mf = new Miniflare({
      modules: [
        { type: "ESModule", path: "worker.mjs", contents: bundled.outputFiles[0].text },
        // A `WebAssembly.Module` the DEPLOYMENT imported: workerd compiles no
        // WebAssembly from bytes at runtime, so this is the only way the screen
        // VM can exist there, and the shape the edge toolchain takes it in.
        { type: "CompiledWasm", path: "quickjs.wasm", contents: await readFile(appsRequire.resolve("@jitl/quickjs-wasmfile-release-sync/wasm")) },
      ],
      compatibilityDate: "2026-07-01",
      compatibilityFlags: [],
    });
    try {
      const response = await mf.dispatchFetch("https://portability.gate/check");
      const body = await response.text();
      if (response.status !== 200) {
        fail(`edge toolchain fixture answered ${response.status} under workerd: ${body.slice(0, 300)}`);
      } else {
        const { transform, typecheck, paint } = JSON.parse(body);
        // The TEXTS, not the node count: a paint that returned an empty tree
        // would otherwise read as a working engine.
        const texts = JSON.stringify(paint.texts);
        if (!transform.engine || !transform.scan) fail(`edge transform produced the wrong forms under workerd: ${JSON.stringify(transform)}`);
        else if (!typecheck.ok) fail(`edge typecheck could not read the screen under workerd: ${typecheck.why}`);
        else if (typecheck.issues.length > 0) fail(`edge typecheck found issues in a clean screen under workerd: ${typecheck.issues.join(", ")}`);
        else if (!paint.ok) fail(`edge paint refused a clean screen under workerd (${paint.kind}): ${paint.message}`);
        else if (texts !== '["One","Two"]') fail(`edge paint rendered ${texts} under workerd, not the screen's two rows`);
        // Not `ok` unless (a) actually proved something: an unresolvable fragment
        // means the absence it reports was never tested.
        else if (loader === undefined && loaderPathIsReal) ok("the edge toolchain bundles with no `node:` specifier permitted and no Node compiler loader in its graph, then compiled, type-checked and painted a screen inside workerd with nodejs_compat OFF");
      }
    } finally {
      await mf.dispose();
    }
  } catch (error) {
    const messages = (error.errors ?? []).slice(0, 8).map((e) => `\n    ${e.text} (${e.location?.file ?? "?"})`).join("");
    fail(
      "the edge toolchain does not survive workerd with nodejs_compat OFF. A `Could not resolve` below is a "
      + "`node:` specifier this bundle refuses to excuse; anything else is the worker itself failing. Either way "
      + "a static import is resolved while the module graph is instantiated, before the handler runs, and being "
      + `uncalled does not save it:${messages || `\n    ${error instanceof Error ? error.message : String(error)}`}`,
    );
  }
}

if (failures > 0) {
  console.error(`portability-gate: ${failures} failure(s)`);
  process.exit(1);
}
console.log("portability-gate: all legs green");
