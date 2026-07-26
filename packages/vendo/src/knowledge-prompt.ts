import type { KnowledgeAdapter, KnowledgeStatus } from "@vendoai/core";
import { knowledgeConfigSchema, VENDO_KNOWLEDGE_SEARCH_TOOL, type KnowledgeConfig } from "@vendoai/knowledge";

/** Knowledge k8 (ENG-368) — the static prompt index + usage guidance. Pure
    assembly: sources come from `.vendo/knowledge.json` (when the developer
    door wrote one), counts from the adapter's `status()`. The caller owns
    WHEN this runs (boot, never per-turn) — the output for a given input is
    byte-stable by construction. */
export function knowledgeIndexSummary(status: KnowledgeStatus, config?: KnowledgeConfig): string {
  const byKind = status.byKind;
  const kindCounts = byKind === undefined
    ? ""
    : (["docs", "glossary", "api"] as const)
        .filter((kind) => (byKind[kind] ?? 0) > 0)
        .map((kind) => `${byKind[kind]} ${kind}`)
        .join(", ");
  const counts = `${status.docs} document${status.docs === 1 ? "" : "s"}${kindCounts === "" ? "" : ` (${kindCounts})`}`;
  const sources = (config?.sources ?? []).map((source) => `${source.name} (${source.kind})`).join(", ");
  return [
    "Knowledge",
    `The host has a product knowledge base of ${counts}${sources === "" ? "" : ` — sources: ${sources}`}.`,
    `- Answer product and how-it-works questions with the ${VENDO_KNOWLEDGE_SEARCH_TOOL} tool instead of guessing; cite what you find.`,
    "- Set lookup:true for an exact glossary or API term lookup.",
    "- Pass readMore:{docId} to read the full document behind a hit when its snippet is not enough.",
    "- On an insufficient-evidence outcome say you don't know; on unavailable say the knowledge base cannot be checked right now.",
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

/** The boot-locked index resolver assembleSystemPrompt consumes. Construction
    is PURE (createVendo may run at Workers module init, where I/O is
    forbidden): the first TURN triggers one status() read, single-flight, and
    the resolved bytes lock forever — later corpus changes surface only on
    reboot, keeping the prompt block byte-stable across turns (prompt-cache
    stability, a hard k8 criterion). A failed status() clears the flight so a
    later turn retries; until then the block is simply absent. */
export function bootLockedKnowledgeIndex(
  adapter: KnowledgeAdapter,
  readConfigFile: () => string | undefined,
): () => Promise<string | undefined> {
  let locked: string | undefined;
  let flight: Promise<string | undefined> | undefined;
  return () => {
    if (locked !== undefined) return Promise.resolve(locked);
    flight ??= adapter.status().then(
      (status) => {
        locked = knowledgeIndexSummary(status, parseKnowledgeConfig(readConfigFile()));
        return locked;
      },
      () => {
        flight = undefined;
        return undefined;
      },
    );
    return flight;
  };
}
