/** SPIKE runner — all rungs in sequence (baseline needs ANTHROPIC_API_KEY). */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
for (const script of ["run-baseline.js", "run-claude.js", "run-codex.js"]) {
  console.log(`\n===== ${script} =====`);
  const r = spawnSync(process.execPath, [join(here, script)], { stdio: "inherit" });
  if (r.status !== 0) console.error(`${script} exited ${r.status}`);
}
