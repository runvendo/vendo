import { z } from "zod";
import { fieldSemanticSchema } from "@vendoai/core";
import {
  clampEnrichment,
  applyEnrichmentFields,
  type EnrichmentFields,
} from "@vendoai/actions/sync";
import type { ExtractedToolV3, OverridesFileV3, ToolsFileV3 } from "@vendoai/actions";
import { resolveDevCredential, type DevCredential } from "../../dev-creds/resolve.js";
import { claudeCliHarness } from "../extract/claude-cli-harness.js";
import { claudeHarness } from "../extract/claude-harness.js";
import { codexCliHarness } from "../extract/codex-cli-harness.js";
import { npxEngineHarness } from "../extract/npx-engine-harness.js";
import { parseArtifact, type ExtractionHarness } from "../extract/harness.js";
import { composeEnrichmentInstructions, composeTripwireInstructions } from "./prompts.js";
import type { EnrichmentDiff } from "./diff.js";

/**
 * The sync AI-enrichment engine (cse lane 1c). ONE engine for init and sync:
 * init's full-repo pass is the degenerate diff (no watermark → full mode);
 * sync's incremental pass feeds it the watermark diff. Proposals ride the
 * same harness seam as init's extraction stages (Read/Glob/Grep-only coding
 * agent, gateway fuel for VENDO_API_KEY — see cli/extract/*), validate
 * against a strict-enough zod schema (unknown keys STRIP, so skeleton junk a
 * model invents is ignored rather than fatal), and every accepted field
 * passes the restrictive-only clamp in @vendoai/actions. Unparseable output
 * degrades to ok:false — the caller warns and keeps the structural file.
 */

/** The AI-writable surface, wire-shaped. Unknown keys (bindings, schemas,
 *  ids…) are stripped by zod's default object behavior — the deterministic
 *  skeleton is not even expressible here. */
export const enrichmentToolProposalSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).max(500).optional(),
  risk: z.enum(["read", "write", "destructive"]).optional(),
  critical: z.boolean().optional(),
  disabled: z.boolean().optional(),
  audience: z.enum(["end-user", "operator", "internal"]).optional(),
  semantics: z.record(fieldSemanticSchema).optional(),
  reasoning: z.string().max(500).optional(),
});
export type EnrichmentToolProposal = z.infer<typeof enrichmentToolProposalSchema>;

export const enrichmentResultSchema = z.object({
  tools: z.array(enrichmentToolProposalSchema),
  narrative: z.string().max(4000).default(""),
});

/** More targeted re-reads than this means the main pass failed wholesale —
 *  the rest are marked stale-unenriched instead of burning a model call each. */
export const TRIPWIRE_LIMIT = 8;

// ---------------------------------------------------------------------------
// Engine resolution — the model ladder at the composition seam (adapter
// rule): explicit harness → explicit --engine pin → BYO provider env /
// VENDO_API_KEY (via dev-creds resolveDevCredential; the harnesses themselves
// implement the console-gateway rung through gateway fuel, the same shape as
// boxInference in server.ts) → none (keyless: structural-only, zero errors).
// ---------------------------------------------------------------------------

/** Rung id → user-facing engine family (`--engine` values) — mirrors init's
 *  ladder in cli/extract/extraction.ts. */
const ENGINE_FAMILIES: Record<string, string> = {
  "claude-agent-sdk": "claude",
  "claude-cli": "claude",
  "codex-cli": "codex",
  "npx-engine": "npx",
};

export interface ResolvedEnrichmentEngine {
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

export async function resolveEnrichmentEngine(
  options: ResolveEngineOptions,
): Promise<{ engine: ResolvedEnrichmentEngine | null; reason?: string }> {
  const resolve = options.resolveCredential ?? resolveDevCredential;
  const credential = await resolve({ env: options.env });
  if (credential.rung === "none") {
    return {
      engine: null,
      reason: "no model credential — set ANTHROPIC_API_KEY / OPENAI_API_KEY (BYO) or VENDO_API_KEY (`vendo login`)",
    };
  }
  const harnesses = options.harnesses
    ?? [claudeHarness(), claudeCliHarness(), codexCliHarness(), npxEngineHarness()];
  for (const harness of harnesses) {
    const family = ENGINE_FAMILIES[harness.id] ?? harness.id;
    if (options.engine !== undefined && family !== options.engine) continue;
    const label = await harness.availability({ root: options.root, env: options.env });
    if (label !== null) return { engine: { harness, credential: label, family } };
  }
  return {
    engine: null,
    reason: options.engine !== undefined
      ? `--engine ${options.engine} is not available on this machine — the pin never falls back to another provider`
      : "no enrichment engine available — needs Claude Code / the codex CLI / a VENDO_API_KEY npx rung (see `vendo init`)",
  };
}

// ---------------------------------------------------------------------------
// The pass itself.
// ---------------------------------------------------------------------------

export interface EnrichmentRunInput {
  root: string;
  env: Record<string, string | undefined>;
  harness: ExtractionHarness;
  appName: string;
  /** The current structural tools file (post-carry). Never mutated. */
  file: ToolsFileV3;
  /** Read-only context: human overrides always win; the model is told so. */
  overrides: OverridesFileV3 | null;
  diff: EnrichmentDiff;
  /** Deterministically computed affected hints: new tools, srcHash-changed
   *  tools (the tripwire tracks these), never-enriched backlog. */
  candidates: { added: string[]; changed: string[]; unenriched: string[] };
  onProgress?: (line: string) => void;
}

export interface EnrichmentOutcome {
  file: ToolsFileV3;
  /** Tool names whose entries changed or were confirmed (now marked enriched). */
  applied: string[];
  /** Restrictive-only clamp refusals, per tool — the narrative counts these. */
  clamped: Array<{ tool: string; refusals: string[] }>;
  /** srcHash-changed tools the model never accounted for, even after the
   *  targeted re-read — marker stripped so the next keyed sync retries. */
  stale: string[];
  /** Tools with no enriched marker after this pass. */
  unenriched: string[];
  modelNarrative: string;
  notes: string[];
}

export type EnrichmentRunResult =
  | { ok: true; outcome: EnrichmentOutcome }
  | { ok: false; error: string };

function proposalFields(proposal: EnrichmentToolProposal): EnrichmentFields {
  return {
    ...(proposal.description === undefined ? {} : { description: proposal.description }),
    ...(proposal.risk === undefined ? {} : { risk: proposal.risk }),
    ...(proposal.critical === undefined ? {} : { critical: proposal.critical }),
    ...(proposal.disabled === undefined ? {} : { disabled: proposal.disabled }),
    ...(proposal.audience === undefined ? {} : { audience: proposal.audience }),
    ...(proposal.semantics === undefined ? {} : { semantics: proposal.semantics }),
  };
}

export async function runEnrichment(input: EnrichmentRunInput): Promise<EnrichmentRunResult> {
  const byName = new Map(input.file.tools.map((tool) => [tool.name, tool]));
  const notes: string[] = [];
  const clamped: Array<{ tool: string; refusals: string[] }> = [];
  const applied = new Set<string>();

  const apply = (proposal: EnrichmentToolProposal): void => {
    const current = byName.get(proposal.name);
    if (current === undefined) {
      notes.push(`enrichment: proposal for unknown tool "${proposal.name}" ignored`);
      return;
    }
    const verdict = clampEnrichment(current, proposalFields(proposal));
    if (verdict.clamped.length > 0) clamped.push({ tool: proposal.name, refusals: verdict.clamped });
    byName.set(proposal.name, applyEnrichmentFields(current, verdict.fields));
    applied.add(proposal.name);
  };

  let modelNarrative: string;
  try {
    input.onProgress?.(input.diff.mode === "diff"
      ? `enriching from the code diff (${input.diff.files.length} changed files)`
      : `enriching the full catalog (${input.file.tools.length} tools)`);
    const text = await input.harness.run({
      root: input.root,
      env: input.env,
      instructions: composeEnrichmentInstructions({
        appName: input.appName,
        diff: input.diff,
        tools: input.file.tools,
        overrides: input.overrides,
        candidates: input.candidates,
      }),
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    });
    const artifact = parseArtifact(text, enrichmentResultSchema);
    modelNarrative = artifact.narrative.trim();
    for (const proposal of artifact.tools) apply(proposal);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "unknown error" };
  }

  // Tripwire: a tool whose SOURCE HASH changed but which the pass never
  // mentioned is exactly the silent-staleness failure mode — one targeted
  // single-tool re-read each; still unmentioned → stale-unenriched (marker
  // stripped so the next keyed sync picks it up again).
  //
  // Known limitation: `candidates.changed` compares the CURRENT srcHash to
  // the previous file's. Intervening KEYLESS syncs rewrite srcHash without
  // advancing the watermark, so an edit made during a keyless window is no
  // longer "changed" relative to the last sync by the time a keyed sync runs
  // — the deterministic tripwire will not force a re-read for it. It is still
  // covered: the watermark diff spans the whole keyless window and surfaces
  // that edit to the model in the main pass; only the silent-staleness NET
  // (the belt-and-suspenders re-read) does not fire for it.
  const stale: string[] = [];
  const unaccounted = input.candidates.changed.filter((name) => !applied.has(name) && byName.has(name));
  for (const [index, name] of unaccounted.entries()) {
    if (index >= TRIPWIRE_LIMIT) {
      notes.push(`enrichment: tripwire budget exhausted (${TRIPWIRE_LIMIT}) — remaining changed tools marked stale`);
      stale.push(...unaccounted.slice(index));
      break;
    }
    const current = byName.get(name)!;
    input.onProgress?.(`tripwire: re-reading ${name}`);
    try {
      const text = await input.harness.run({
        root: input.root,
        env: input.env,
        instructions: composeTripwireInstructions({ appName: input.appName, tool: current }),
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      });
      const artifact = parseArtifact(text, enrichmentResultSchema);
      const proposal = artifact.tools.find((entry) => entry.name === name);
      if (proposal === undefined) {
        stale.push(name);
      } else {
        apply(proposal);
      }
    } catch (error) {
      notes.push(`enrichment: tripwire re-read for ${name} failed (${error instanceof Error ? error.message : "unknown error"})`);
      stale.push(name);
    }
  }
  for (const name of stale) {
    const current = byName.get(name);
    if (current?.enriched === true) {
      const { enriched: _stripped, ...rest } = current;
      byName.set(name, rest as ExtractedToolV3);
    }
  }

  const tools = input.file.tools.map((tool) => byName.get(tool.name) ?? tool);
  const outcome: EnrichmentOutcome = {
    file: { ...input.file, tools },
    applied: [...applied].sort(),
    clamped,
    stale: stale.sort(),
    unenriched: tools.filter((tool) => tool.enriched !== true).map((tool) => tool.name),
    modelNarrative,
    notes,
  };
  return { ok: true, outcome };
}
