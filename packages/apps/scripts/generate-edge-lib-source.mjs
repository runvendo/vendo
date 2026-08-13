/**
 * Regenerate `src/server/edge/lib-source.ts` — TypeScript's standard library,
 * as string constants.
 *
 * The edge toolchain type-checks a screen inside a Worker, where there is no
 * filesystem and no `ts.sys`, so the compiler cannot read its own lib files off
 * disk. It reads them out of a `Map` instead, and the bytes have to arrive in
 * the bundle. Copying the closure from `lib.es2020.d.ts` — the standard library
 * a component screen is checked against (checking/component-screen.ts:534) —
 * keeps that bundle to what the screen actually needs.
 *
 * Run from `packages/apps`, after `pnpm install`:
 *   node scripts/generate-edge-lib-source.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const typescript = require("typescript-6/package.json");
const libDir = join(dirname(require.resolve("typescript-6/package.json")), "lib");

/** The lib a component screen is checked against, and the root of the closure. */
const ROOT = "lib.es2020.d.ts";

/** `/// <reference lib="es2019" />` — how a lib file names the ones it needs. */
const REFERENCE = /\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/gu;

const sources = new Map();
const pending = [ROOT];
while (pending.length > 0) {
  const name = pending.pop();
  if (sources.has(name)) continue;
  const text = readFileSync(join(libDir, name), "utf8");
  sources.set(name, text);
  for (const [, lib] of text.matchAll(REFERENCE)) pending.push(`lib.${lib}.d.ts`);
}

const names = [...sources.keys()].sort();
const entries = names.map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(sources.get(name))},`);
const bytes = names.reduce((total, name) => total + Buffer.byteLength(sources.get(name)), 0);

const file = `/**
 * TypeScript's standard library, vendored as SOURCE TEXT.
 *
 * The edge toolchain runs the real compiler inside a Worker (see ./typecheck.ts),
 * and a Worker has no filesystem: \`ts.sys\` does not exist there, so the compiler
 * cannot read its own lib files the way it does in Node. It reads them out of a
 * plain lookup instead, and these strings are what fills it — no \`fs\`, no
 * bundler asset, no deploy-time copy step. \`tsc\` emits this module as \`.js\`
 * with the strings intact.
 *
 * THE PIN. \`typescript\` is pinned EXACTLY in packages/apps/package.json (as the
 * \`typescript-6\` alias, and as the \`/edge\` peer range), and these strings are a
 * copy of that exact tarball's \`lib/\`. Bumping the pin without regenerating this
 * file changes nothing at runtime — the pin is the provenance of these bytes,
 * not the code path. Regenerate in the same commit as any bump.
 *
 * THE CLOSURE is everything \`${ROOT}\` references, transitively — the
 * standard library a component screen is checked against
 * (checking/component-screen.ts:534), and nothing else. No DOM lib, for the
 * gauntlet's own reason: \`document\` and \`fetch\` genuinely do not exist in a
 * screen, so naming one must be an error.
 *
 * Regenerate (from packages/apps, after \`pnpm install\`):
 *   node scripts/generate-edge-lib-source.mjs
 */

/** The pinned TypeScript these strings were copied from. */
export const EDGE_TYPESCRIPT_VERSION = ${JSON.stringify(typescript.version)};

/** What \`getDefaultLibFileName\` must answer: a name this table carries. */
export const EDGE_DEFAULT_LIB = ${JSON.stringify(ROOT)};

/** ${names.length} lib files, ${bytes} bytes, keyed by the bare name the compiler asks for. */
export const EDGE_LIB_SOURCES: Record<string, string> = {
${entries.join("\n")}
};
`;

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../src/server/edge/lib-source.ts");
writeFileSync(out, file);
process.stdout.write(`${names.length} lib files, ${bytes} bytes, from typescript@${typescript.version}\n`);
