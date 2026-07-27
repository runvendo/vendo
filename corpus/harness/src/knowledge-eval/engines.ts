import type { KnowledgeAdapter, KnowledgeContext } from "@vendoai/core";
import { memoryKnowledgeAdapter, memoryStoreAdapter } from "@vendoai/core/conformance";
import { lexicalKnowledge } from "@vendoai/knowledge";

/**
 * The engine registry. An engine joins the matrix with exactly two changes
 * (docs/eval/KNOWLEDGE.md §How an engine joins): a case here plus a
 * calibrated bars/<engine>.json. `memory` and `lexical` are the per-PR
 * offline engines (lexical over an in-memory store, the same wiring as K7's
 * own conformance tests); `cloud` (lane K3) adds a case when it lands — live
 * engines must read their credentials from env and fail fast without them.
 */
export const KNOWLEDGE_ENGINES: Record<string, () => KnowledgeAdapter> = {
  memory: () => memoryKnowledgeAdapter(),
  lexical: () => lexicalKnowledge({ store: memoryStoreAdapter() }),
};

export function createEngine(name: string): KnowledgeAdapter {
  const factory = KNOWLEDGE_ENGINES[name];
  if (!factory) {
    throw new Error(
      `Unknown knowledge engine "${name}". Known engines: ${Object.keys(KNOWLEDGE_ENGINES).join(", ")}.`,
    );
  }
  return factory();
}

/** The eval's fixture principal. `includeInternal` is never set: the eval
    measures the public-only default posture (internal fixture docs must
    never surface). */
export const EVAL_CONTEXT: KnowledgeContext = {
  principal: { kind: "user", subject: "knowledge-eval" },
};
