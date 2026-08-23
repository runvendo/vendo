/**
 * The `ai-dual` lane's install half: rewrite the workspace to the ai@7 pairing.
 *
 * Vendo's peers admit both live AI SDK majors (`ai >=6 <8`), and a peer range is
 * a claim nobody checks — the suite resolves ONE major, and by default that is
 * the v6-era pin every package's devDependencies name. This flips the whole tree
 * to the other one so the same suite runs against it, in CI (`ai-dual`) and
 * locally (`pnpm test:ai7`) the same way.
 *
 * pnpm 11 reads overrides from pnpm-workspace.yaml, so the pins go there rather
 * than into every package.json: an override reaches transitive resolutions too,
 * which is where a half-flipped tree would otherwise hide. The edit is
 * THROWAWAY — a lane run leaves the file dirty and neither caller commits it.
 */
import { readFile, writeFile } from "node:fs/promises";

/**
 * THE PIN. Each `@ai-sdk/*` major is the one that ships against ai@7, and every
 * version here is EXACT for one reason: a floating range hands upstream the
 * power to red every open branch at whatever hour its publish clears pnpm's 24h
 * quarantine. Not hypothetical — `ai@7.0.70` did precisely that on 2026-08-20,
 * failed `ai-dual` on every PR and merge_group alike, and blocked the queue
 * until #1584.
 *
 * So the lanes people merge against are pinned, and the ai-dual NIGHTLY
 * workflow is the thing that floats (AI7_FLOAT below): upstream drift gets
 * found on a schedule, against main, where a red is a notification instead of
 * everyone's problem. Moving a version here is therefore a deliberate PR with
 * a green run behind it — never an accident of the clock.
 *
 * These six are what the lane last ran green on: main run 32525724379,
 * 2026-08-21T20:53Z.
 */
const PAIRING = {
  ai: "7.0.71",
  "@ai-sdk/anthropic": "4.0.40",
  "@ai-sdk/react": "4.0.74",
  "@ai-sdk/openai": "4.0.45",
  "@ai-sdk/google": "4.0.48",
  "@ai-sdk/openai-compatible": "3.0.33",
};

// The nightly floats the same pairing to the newest of each major. `^` on an
// exact version is exactly that range, so the one flag covers all six and the
// pinned set stays the single list to edit.
const caret = process.env.AI7_FLOAT === "true" ? "^" : "";
const file = new URL("../pnpm-workspace.yaml", import.meta.url);
const pins = Object.entries(PAIRING).map(([name, v]) => `  "${name}": "${caret}${v}"`).join("\n");
const manifest = await readFile(file, "utf8");
if (!/^overrides:$/m.test(manifest)) throw new Error("pnpm-workspace.yaml has no `overrides:` block to pin into");
await writeFile(file, manifest.replace(/^overrides:$/m, `overrides:\n${pins}`));
console.log(`${caret ? "FLOATED" : "pinned"} the AI SDK to its v7 pairing:\n${pins}\n`);
console.log("this edit is throwaway — `git checkout pnpm-workspace.yaml pnpm-lock.yaml && pnpm install` puts the tree back on ai@6.\n");
