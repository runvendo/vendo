import { resolveDevCredential, type DevCredential } from "../../dev-creds/resolve.js";
import { claudeCliHarness } from "../extract/claude-cli-harness.js";
import { claudeHarness } from "../extract/claude-harness.js";
import { codexCliHarness } from "../extract/codex-cli-harness.js";
import { npxEngineHarness } from "../extract/npx-engine-harness.js";
import type { ExtractionHarness } from "../extract/harness.js";

/**
 * The judgment pass's model ladder — ONE merged resolver where the enrichment
 * pass and init's extraction each had their own half. Two properties matter and
 * both are preserved verbatim:
 *
 * - the CREDENTIAL gate comes first (resolveDevCredential: BYO provider key →
 *   VENDO_API_KEY → none), so a keyless repo never probes a single harness. The
 *   probes are local and cheap but they are still observable work, and the
 *   keyless answer is "structural-only", not "try anyway";
 * - an `--engine` pin NEVER falls back to another provider. The pin is usually a
 *   privacy decision about where source code goes, so silently satisfying it
 *   with a different vendor would be the worst possible helpfulness.
 *
 * Availability is then swept across the WHOLE ladder rather than stopping at the
 * first hit (every check is local), because the unavailable-pin message can only
 * name the real alternatives if it knows all of them.
 *
 * Ported, not imported: the two halves this merges live in files lane C2
 * deletes. The four harnesses survive and are imported directly.
 */

/** Rung id → user-facing engine family (`--engine` values). The Agent SDK and
 *  the claude CLI are ONE family: same provider, same credential story. An
 *  unknown id (test seams, future rungs) is its own family. */
const ENGINE_FAMILIES: Record<string, string> = {
  "claude-agent-sdk": "claude",
  "claude-cli": "claude",
  "codex-cli": "codex",
  "npx-engine": "npx",
};

/** One available rung: the harness, the human credential label its availability
 *  check reported, and the `--engine` family that rung speaks for. */
export interface AvailableEngine {
  harness: ExtractionHarness;
  credential: string;
  family: string;
}

export interface ResolveEngineOptions {
  root: string;
  env: Record<string, string | undefined>;
  /** Explicit family pin (claude | codex | npx). Unavailable pin → null, loudly. */
  engine?: string;
  /** Test seams. */
  harnesses?: ExtractionHarness[];
  resolveCredential?: (options: { env: Record<string, string | undefined> }) => Promise<DevCredential>;
}

/**
 * The ordered ladder: Agent SDK → claude CLI → codex CLI → npx-fetched engine.
 * A rung whose availability() is null (binary missing, or present but
 * unauthenticated) is skipped; ladder order encodes preference, and the npx rung
 * is last on purpose because it is the only one with a real first-run cost.
 * The first available rung of a family speaks for that family.
 */
export async function selectJudgmentEngines(input: {
  root: string;
  env: Record<string, string | undefined>;
  harnesses?: ExtractionHarness[];
}): Promise<AvailableEngine[]> {
  const harnesses = input.harnesses
    ?? [claudeHarness(), claudeCliHarness(), codexCliHarness(), npxEngineHarness()];
  const available: AvailableEngine[] = [];
  for (const harness of harnesses) {
    const family = ENGINE_FAMILIES[harness.id] ?? harness.id;
    if (available.some((entry) => entry.family === family)) continue;
    const credential = await harness.availability({ root: input.root, env: input.env });
    if (credential !== null) available.push({ harness, credential, family });
  }
  return available;
}

export async function resolveJudgmentEngine(
  options: ResolveEngineOptions,
): Promise<{ engine: AvailableEngine | null; reason?: string }> {
  const resolve = options.resolveCredential ?? resolveDevCredential;
  const credential = await resolve({ env: options.env });
  if (credential.rung === "none") {
    return {
      engine: null,
      reason: "no model credential — set ANTHROPIC_API_KEY / OPENAI_API_KEY (BYO) or VENDO_API_KEY (`vendo login`)",
    };
  }

  const available = await selectJudgmentEngines(options);
  if (options.engine !== undefined) {
    const pinned = available.find((entry) => entry.family === options.engine);
    if (pinned !== undefined) return { engine: pinned };
    const alternatives = available
      .map((entry) => `\`--engine ${entry.family}\` (${entry.credential})`)
      .join(", or ");
    return {
      engine: null,
      reason: `--engine ${options.engine} is not available on this machine — the pin never falls back to another provider`
        + (alternatives === "" ? "" : `. Available: ${alternatives}`),
    };
  }

  const first = available[0];
  if (first === undefined) {
    return {
      engine: null,
      reason: "no judgment engine available — needs Claude Code / the codex CLI / a VENDO_API_KEY npx rung (see `vendo init`)",
    };
  }
  return { engine: first };
}
