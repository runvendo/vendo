import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateTree } from "@vendoai/core";
import type { Tree } from "@vendoai/core";

const HERE = dirname(fileURLToPath(import.meta.url));
/** dist/ sits next to fixtures/ at the package root. */
export const FIXTURES_DIR = join(HERE, "..", "fixtures");

export interface LoadedFixture {
  name: string;
  tree: Tree;
}

/** Strip provenance/meta keys (prefixed `_`) so they don't skew measurements. */
function stripMeta(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith("_")) out[k] = v;
  }
  return out;
}

function loadDir(dir: string, prefix: string): LoadedFixture[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: LoadedFixture[] = [];
  for (const file of entries.sort()) {
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    const candidate = stripMeta(raw);
    const result = validateTree(candidate);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(`skipping invalid fixture ${file}: ${result.error.message}`);
      continue;
    }
    out.push({ name: `${prefix}/${file.replace(/\.json$/, "")}`, tree: result.tree });
  }
  return out;
}

export function loadFixtures(): LoadedFixture[] {
  return [
    ...loadDir(join(FIXTURES_DIR, "harvested"), "harvested"),
    ...loadDir(join(FIXTURES_DIR, "generated"), "generated"),
  ];
}

/** Lazily build the Anthropic SDK client; throws a clear message when unkeyed. */
export async function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. This is a key-gated measurement script — " +
        "`source /Users/yousefh/orca/workspaces/flowlet/.env` first (never print or commit the value).",
    );
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic();
}

export const COUNT_MODEL = process.env.COUNT_MODEL ?? "claude-sonnet-5";
export const GEN_MODEL = process.env.GEN_MODEL ?? "claude-sonnet-5";

/** utf-8 byte length. */
export function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function pct(from: number, to: number): string {
  if (from === 0) return "n/a";
  return `${(((from - to) / from) * 100).toFixed(1)}%`;
}
