#!/usr/bin/env node
// Report-only lint over packages/*: eslint-plugin-sonarjs + knip. Prints what
// both tools find and ALWAYS exits 0. `pnpm lint` is the blocking gate; this
// is deliberately not part of it. See CONTRIBUTING.md.
//
// A Node script rather than a one-line shell script because the second tool
// must run even when the first one finds something, and no shell spelling of
// that means the same thing everywhere: pnpm runs scripts through cmd.exe on
// Windows, where `true` is not a command and `;` is not a separator, so
// `eslint || true; knip` would silently skip knip on every run that had
// findings — which, at ~1,100 of them, is every run.
//
// The tools are launched as JS entry points under this same Node rather than
// through node_modules/.bin, whose Windows entries are .CMD shims that
// spawnSync can only exec via a shell — and a shell is the thing being avoided.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const steps = [
  ["node_modules/eslint/bin/eslint.js", [
    "--config", "eslint.report.config.mjs",
    "--no-config-lookup",
    "packages/*/**/*.{ts,tsx}",
  ]],
  ["node_modules/knip/bin/knip.js", ["--no-exit-code"]],
];

const missing = steps.filter(([entry]) => !existsSync(join(root, entry)));
for (const [entry, args] of steps) {
  if (missing.some(([m]) => m === entry)) continue;
  // Findings are the point, so a non-zero exit status is ignored on purpose.
  spawnSync(process.execPath, [join(root, entry), ...args], { cwd: root, stdio: "inherit" });
}
// A tool that never ran has to be loud. A partial census that reads as a
// complete one is the exact failure this report exists to surface.
for (const [entry] of missing) console.error(`\nlint:report: ${entry} is missing — run \`pnpm install\`.`);
if (missing.length > 0) {
  console.error(`lint:report: ${missing.length} of ${steps.length} tools did not run; the counts above are incomplete.`);
}
