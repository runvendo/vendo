#!/usr/bin/env node
// Keeps the hand-maintained version constants in @vendoai/vendo and
// @vendoai/core in lockstep with package.json (every published package is one
// `fixed` group, so one version serves all of them). Runs as part of
// `pnpm changeset:version` so the Version Packages PR is self-consistent;
// cli/shared.test.ts and core's store-wire.test.ts pin the invariant either way.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(
  readFileSync(join(root, "packages/vendo/package.json"), "utf8"),
).version;

const targets = [
  { file: "packages/vendo/src/cli/shared.ts", pattern: /(export const CLI_VERSION = ")[^"]+(")/ },
  { file: "packages/vendo/src/wire/shared.ts", pattern: /(export const VERSION = ")[^"]+(")/ },
  {
    file: "packages/core/src/store-wire.ts",
    pattern: /(export const STORE_WIRE_MIN_CLIENT_VERSION = ")[^"]+(")/,
  },
];

for (const { file, pattern } of targets) {
  const path = join(root, file);
  const source = readFileSync(path, "utf8");
  if (!pattern.test(source)) {
    console.error(`sync-version-constants: pattern not found in ${file}`);
    process.exit(1);
  }
  const next = source.replace(pattern, `$1${version}$2`);
  if (next !== source) {
    writeFileSync(path, next);
    console.log(`sync-version-constants: ${file} -> ${version}`);
  } else {
    console.log(`sync-version-constants: ${file} already ${version}`);
  }
}
