#!/usr/bin/env node
/**
 * Publish-hygiene gate for the @vendoai/* packages (pre-ENG-198).
 * Checks every non-private package in packages/*:
 *   1. no `dependencies` entry may point at a private workspace package
 *   2. no `dependencies` entry may use the `file:` protocol
 *   3. a `files` allowlist must exist (npm pack must not ship src/tests/.turbo)
 *   4. no package may list the same dep in both dependencies and devDependencies
 *   5. scoped packages must declare publishConfig.access = "public"
 * Exits 1 with a per-package report on any violation.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgsDir = path.join(root, "packages");

// Known violations awaiting a product decision — keep this list shrinking.
// (fluidkit was resolved by bundling it into shell's dist — a devDependency
// file: path is fine; only published `dependencies` are checked.)
const KNOWN = new Set([]);

const manifests = new Map();
for (const dir of readdirSync(pkgsDir)) {
  const p = path.join(pkgsDir, dir, "package.json");
  if (existsSync(p)) manifests.set(dir, JSON.parse(readFileSync(p, "utf8")));
}
const privateNames = new Set(
  [...manifests.values()].filter((m) => m.private).map((m) => m.name),
);

const failures = [];
const known = [];
for (const [dir, m] of manifests) {
  if (m.private) continue;
  const flag = (id, msg) =>
    (KNOWN.has(id) ? known : failures).push(`${m.name}: ${msg}`);

  for (const [dep, spec] of Object.entries(m.dependencies ?? {})) {
    if (privateNames.has(dep))
      flag(`${m.name}:private-dep:${dep}`, `dependency ${dep} is private and would break install`);
    if (String(spec).startsWith("file:"))
      flag(`${m.name}:file-dep:${dep.replace(/^@vendoai\//, "")}`, `dependency ${dep} uses a file: path (${spec}) — uninstallable off npm`);
    if (m.devDependencies?.[dep] !== undefined)
      flag(`${m.name}:dup-dep:${dep}`, `${dep} in both dependencies and devDependencies`);
  }
  if (!Array.isArray(m.files) || m.files.length === 0)
    flag(`${m.name}:files`, `no "files" allowlist — npm pack would ship src, tests, .turbo logs`);
  if (m.name.startsWith("@") && m.publishConfig?.access !== "public")
    flag(`${m.name}:access`, `missing publishConfig.access "public" — first scoped publish fails`);
}

for (const k of known) console.log(`KNOWN (decision pending): ${k}`);
if (failures.length) {
  console.error(`publish hygiene: ${failures.length} violation(s)`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`publish hygiene: OK (${[...manifests.values()].filter((m) => !m.private).length} publishable packages checked)`);
