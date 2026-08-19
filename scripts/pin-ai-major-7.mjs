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

/** The v7 pairing. Each `@ai-sdk/*` major is the one that ships against ai@7. */
const PAIRING = {
  ai: "^7.0.0",
  "@ai-sdk/anthropic": "^4.0.0",
  "@ai-sdk/react": "^4.0.0",
  "@ai-sdk/openai": "^4.0.0",
  "@ai-sdk/google": "^4.0.0",
  "@ai-sdk/openai-compatible": "^3.0.0",
};

const file = new URL("../pnpm-workspace.yaml", import.meta.url);
const pins = Object.entries(PAIRING).map(([name, range]) => `  "${name}": "${range}"`).join("\n");
const manifest = await readFile(file, "utf8");
if (!/^overrides:$/m.test(manifest)) throw new Error("pnpm-workspace.yaml has no `overrides:` block to pin into");
await writeFile(file, manifest.replace(/^overrides:$/m, `overrides:\n${pins}`));
console.log(`pinned the AI SDK to its v7 pairing:\n${pins}\n`);
console.log("this edit is throwaway — `git checkout pnpm-workspace.yaml pnpm-lock.yaml && pnpm install` puts the tree back on ai@6.\n");
