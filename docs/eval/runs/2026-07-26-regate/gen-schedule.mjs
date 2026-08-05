/**
 * Re-gate arm-order schedule generator — mulberry32 seed 20260726 (the run
 * date, same convention as the 2026-07-25 rematch's seed 20260725). One
 * random permutation of "ABC" per prompt, committed BEFORE the run so the
 * per-prompt arm order is documented and non-cherry-pickable.
 *
 * Usage: node gen-schedule.mjs > arm-schedule.json
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260726);
const here = dirname(fileURLToPath(import.meta.url));
const prompts = JSON.parse(readFileSync(join(here, "prompts.json"), "utf8"));

const schedule = {};
for (const id of Object.keys(prompts)) {
  const arms = ["A", "B", "C"];
  for (let i = arms.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arms[i], arms[j]] = [arms[j], arms[i]];
  }
  schedule[id] = arms.join("");
}
console.log(JSON.stringify(schedule, null, 2));
