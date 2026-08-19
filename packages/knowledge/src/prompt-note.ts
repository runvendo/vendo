import type { KnowledgeAdapter, KnowledgeStatus } from "@vendoai/core";
import { VENDO_KNOWLEDGE_SEARCH_TOOL } from "./agent-tools.js";
import { knowledgeConfigSchema, type KnowledgeConfig } from "./ingest/index.js";

/** The static prompt index + usage guidance. Pure
    assembly: sources come from `.vendo/knowledge.json` (when the developer
    door wrote one), counts from the adapter's `status()`. The caller owns
    WHEN this runs (boot + sync-state change, never per-turn) — the output
    for a given input is byte-stable by construction.

    The index rides END-USER prompts, so it
    names PUBLIC sources only — an internal source's existence is corpus
    metadata and must never surface on a principal-facing path, exactly like
    internal hits. Counts stay aggregate (no per-source identity). */
export function knowledgeIndexSummary(status: KnowledgeStatus, config?: KnowledgeConfig): string {
  const byKind = status.byKind;
  const kindCounts = byKind === undefined
    ? ""
    : (["docs", "glossary", "api"] as const)
        .filter((kind) => (byKind[kind] ?? 0) > 0)
        .map((kind) => `${byKind[kind]} ${kind}`)
        .join(", ");
  const counts = `${status.docs} document${status.docs === 1 ? "" : "s"}${kindCounts === "" ? "" : ` (${kindCounts})`}`;
  const sources = (config?.sources ?? [])
    .filter((source) => source.visibility === "public")
    .map((source) => `${source.name} (${source.kind})`)
    .join(", ");
  return [
    "Knowledge",
    `The host has a product knowledge base of ${counts}${sources === "" ? "" : ` — sources: ${sources}`}.`,
    `- Answer product and how-it-works questions with the ${VENDO_KNOWLEDGE_SEARCH_TOOL} tool instead of guessing; cite what you find.`,
    "- Set lookup:true for an exact glossary or API term lookup.",
    "- Pass readMore:{docId} to read the full document behind a hit when its snippet is not enough.",
    `- On an insufficient-evidence outcome say you don't know; on unavailable say the docs cannot be checked right now. When you mention this to the user call it "the docs" — never "knowledge base".`,
  ].join("\n");
}

/** Parses a `.vendo/knowledge.json` read fail-soft: the file is an ingestion
    input, so the prompt index must survive its absence (engines configured
    programmatically have no file) and a hand-broken file must not take the
    compose down — the CLI is where invalid config fails loudly. */
export function parseKnowledgeConfig(raw: string | undefined): KnowledgeConfig | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = knowledgeConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export interface KnowledgeIndexReaders {
  /** Raw `.vendo/knowledge.json` contents (fail-soft). */
  readConfig(): string | undefined;
  /** Raw `.vendo/knowledge-manifest.json` contents (fail-soft) — sync writes
      it LAST, so its bytes ARE the sync-state fingerprint. */
  readManifest(): string | undefined;
}

/** The index resolver assembleSystemPrompt consumes. Construction is PURE
    (createVendo may run at Workers module init, where I/O is forbidden).

    Refresh contract (real invalidation, not a
    boot-forever lock):
    - At a FIXED sync state (same manifest bytes) every turn returns the SAME
      cached string — byte-stable, zero adapter I/O (prompt-cache stability).
    - When the sync manifest changes (`vendo knowledge sync` writes it last),
      the next turn re-reads config + status() once and re-caches — the
      per-turn cost is one fail-soft file read, never a rebuild.
    - Setups without a manifest (programmatic adapters, no CLI sync) have a
      constant fingerprint: the index locks at first resolution and refreshes
      at reboot, the documented boot posture.
    - A failed status() keeps serving the last good bytes (a sick engine must
      not strip guidance mid-session); with nothing cached yet the block is
      simply absent and the next turn retries. A failure that arrived SLOWLY is
      the exception — see SLOW_FAILURE_MS. */
/** A refused connection fails in microseconds and is retried on the very next
    turn (a recovered engine must be picked up at once). An engine that is UP but
    HANGING is the expensive kind: the wire client aborts at its own 30s timeout,
    and every turn pays that before the prompt can be built. Past this bound a
    failure counts as slow and the engine is left alone for the cool-off — which
    costs only recovery latency, since a turn inside it serves exactly what the
    failure itself would have returned. */
const SLOW_FAILURE_MS = 1_000;
const SLOW_FAILURE_COOL_OFF_MS = 60_000;

export function knowledgeIndexResolver(
  adapter: KnowledgeAdapter,
  readers: KnowledgeIndexReaders,
): () => Promise<string | undefined> {
  let cached: { fingerprint: string | undefined; text: string } | undefined;
  let flight: Promise<string | undefined> | undefined;
  let coolOffUntil = 0;
  return () => {
    const fingerprint = readers.readManifest();
    if (cached !== undefined && cached.fingerprint === fingerprint) return Promise.resolve(cached.text);
    if (Date.now() < coolOffUntil) return Promise.resolve(cached?.text);
    const startedAt = Date.now();
    flight ??= adapter.status().then(
      (status) => {
        cached = { fingerprint, text: knowledgeIndexSummary(status, parseKnowledgeConfig(readers.readConfig())) };
        flight = undefined;
        return cached.text;
      },
      () => {
        flight = undefined;
        if (Date.now() - startedAt >= SLOW_FAILURE_MS) coolOffUntil = Date.now() + SLOW_FAILURE_COOL_OFF_MS;
        return cached?.text;
      },
    );
    return flight;
  };
}
