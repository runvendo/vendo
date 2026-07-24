import type {
  KnowledgeAdapter,
  KnowledgeContext,
  KnowledgeDoc,
  KnowledgeHit,
  KnowledgeQuery,
} from "../index.js";

export interface MemoryKnowledgeAdapterOptions {
  docs?: KnowledgeDoc[];
}

const SNIPPET_RADIUS = 80;

const snippetAround = (text: string, needle: string): string => {
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return text.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, index - SNIPPET_RADIUS);
  return text.slice(start, index + needle.length + SNIPPET_RADIUS);
};

/** Full-posture in-memory KnowledgeAdapter: the conformance stub (ENG-358
    gate) and the test double later engine work builds against. Naive
    substring retrieval — deliberately not a quality bar, just contract-true. */
export function memoryKnowledgeAdapter(options: MemoryKnowledgeAdapterOptions = {}): KnowledgeAdapter {
  const docs = new Map<string, KnowledgeDoc>();
  for (const doc of options.docs ?? []) docs.set(doc.id, doc);

  return {
    posture: { fetch: true, write: true, visibility: "enforced" },

    async search(query: KnowledgeQuery, ctx: KnowledgeContext) {
      const limit = query.limit ?? 10;
      const hits: KnowledgeHit[] = [];
      for (const doc of docs.values()) {
        if (doc.visibility === "internal" && ctx.includeInternal !== true) continue;
        if (query.kinds !== undefined && !query.kinds.includes(doc.kind)) continue;
        const haystack = `${doc.title}\n${doc.text}`.toLowerCase();
        if (!haystack.includes(query.text.toLowerCase())) continue;
        hits.push({
          ref: { docId: doc.id, chunkId: `${doc.id}#0`, title: doc.title, source: doc.source },
          snippet: snippetAround(`${doc.title}\n${doc.text}`, query.text),
          kind: doc.kind,
          visibility: doc.visibility,
          score: 1,
        });
        if (hits.length >= limit) break;
      }
      return { hits };
    },

    async fetch(ref, ctx) {
      const doc = docs.get(ref.docId);
      if (doc === undefined) return null;
      if (doc.visibility === "internal" && ctx.includeInternal !== true) return null;
      return { ref: { docId: doc.id, title: doc.title, source: doc.source }, text: doc.text };
    },

    async upsert(incoming) {
      for (const doc of incoming) docs.set(doc.id, doc);
    },

    async remove(docIds) {
      for (const id of docIds) docs.delete(id);
    },

    async status() {
      const byKind: Partial<Record<KnowledgeDoc["kind"], number>> = {};
      for (const doc of docs.values()) byKind[doc.kind] = (byKind[doc.kind] ?? 0) + 1;
      return { docs: docs.size, byKind };
    },
  };
}
