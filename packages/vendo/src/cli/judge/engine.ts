import { resolveDevCredential, type DevCredential } from "../../dev-creds/resolve.js";
import { claudeCliHarness } from "../extract/claude-cli-harness.js";
import { claudeHarness } from "../extract/claude-harness.js";
import { codexCliHarness } from "../extract/codex-cli-harness.js";
import { hasOwnAnthropicEnvOverride } from "../extract/gateway-fuel.js";
import { npxEngineHarness } from "../extract/npx-engine-harness.js";
import type { ExtractionHarness } from "../extract/harness.js";

/**
 * The judgment pass's model ladder — ONE merged resolver where the enrichment
 * pass and init's extraction each had their own half. Two properties matter and
 * both are preserved verbatim:
 *
 * - the CREDENTIAL gate comes first (resolveDevCredential: BYO provider key →
 *   VENDO_API_KEY → none, WIDENED here by Claude Code's own-credential env vars
 *   — see the gate itself), so a keyless repo never probes a single harness. The
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

/** The provider keys a ladder rung authenticates with DIRECTLY — the claude
 *  rungs read ANTHROPIC_API_KEY (claude-cli-harness.ts:112,
 *  npx-engine-harness.ts:240) and the codex rung reads OPENAI_API_KEY
 *  (codex-cli-harness.ts:159). Since the selection law resolveDevCredential no
 *  longer sweeps them at all, so without them here the gate starved harnesses
 *  that run on exactly these keys and told a developer whose only credential is
 *  ANTHROPIC_API_KEY to set ANTHROPIC_API_KEY. Deliberately NOT folded into
 *  OWN_CREDENTIAL_ENV_VARS: that set also decides gateway fuel, where an OpenAI
 *  key must not stop an Anthropic rung from being fuelled. No
 *  GOOGLE_GENERATIVE_AI_API_KEY either — no rung can run on it. */
const ENGINE_PROVIDER_KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

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

/** Any credential SOME rung of this ladder can run on, read off the env alone
 *  (no probe): Claude Code's own-credential vars, or a provider key a harness
 *  authenticates with directly. */
function hasEngineCredential(env: Record<string, string | undefined>): boolean {
  if (hasOwnAnthropicEnvOverride(env)) return true;
  return ENGINE_PROVIDER_KEY_VARS.some((name) => (env[name] ?? "").trim() !== "");
}

export async function resolveJudgmentEngine(
  options: ResolveEngineOptions,
): Promise<{ engine: AvailableEngine | null; reason?: string }> {
  const resolve = options.resolveCredential ?? resolveDevCredential;
  const credential = await resolve({ env: options.env });
  // resolveDevCredential answers a DIFFERENT question — what can serve a
  // product turn at runtime — and real API keys are the only answer to that
  // one (doctor and dev-creds/model.ts both read it, so it must
  // stay that way). A coding agent is not a product turn: Claude Code also
  // runs on an interactive OAuth token or a corporate endpoint, none of which
  // is a key. Without this widening, `vendo sync --ai` on an incremental run —
  // the ONE path that falls back to this resolver instead of sweeping the
  // ladder — told those devs they had no engine while `vendo init` and an
  // interactive `vendo sync` ran fine on the same credentials.
  //
  // The widening covers the coding-agent env vars AND the two provider keys a
  // rung authenticates with itself (ENGINE_PROVIDER_KEY_VARS), which is also
  // what keeps the reason below honest: it can only be reached when every
  // credential it names is genuinely absent, so it never advises setting a key
  // the developer already set.
  if (credential.rung === "none" && !hasEngineCredential(options.env)) {
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
