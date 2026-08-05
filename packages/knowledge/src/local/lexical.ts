import {
  VendoError,
  type KnowledgeAdapter,
  type KnowledgeChunk,
  type KnowledgeContext,
  type KnowledgeDoc,
  type KnowledgeHit,
  type KnowledgeKind,
  type KnowledgeQuery,
  type KnowledgeStatus,
  type RecordStore,
  type StoreAdapter,
  type VendoRecord,
} from "@vendoai/core";
import { KNOWLEDGE_CHUNKS_COLLECTION, KNOWLEDGE_DOCS_COLLECTION } from "../collections.js";
import { structuralChunker } from "../ingest/chunker.js";

/** A stored chunk row: the chunk plus doc fields denormalized at upsert time
    (upsert replaces every chunk of a doc, so they can never go stale) —
    search filters visibility and boosts titles without a per-row doc join. */
interface ChunkRow extends KnowledgeChunk {
  kind: KnowledgeDoc["kind"];
  visibility: KnowledgeDoc["visibility"];
  title: string;
}

/** LIST PAGINATION ruling: every corpus scan pages with the keyset cursor
    (page cap 1000); status()-style counts via paginated scan are the
    accepted R1 answer. */
async function listAll(store: RecordStore, refs?: Record<string, string>): Promise<VendoRecord[]> {
  const records: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ ...(refs === undefined ? {} : { refs }), limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
    records.push(...page.records);
    if (page.records.length === 0) break;
    cursor = page.cursor;
  } while (cursor !== undefined);
  return records;
}

const tokenize = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1);

const SNIPPET_RADIUS = 100;

function snippetAround(text: string, tokens: string[]): string {
  const lower = text.toLowerCase();
  const at = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  return text.slice(start, at + SNIPPET_RADIUS * 2).trim();
}

/** Exact-lookup normalization for schema intent: a term matches on its title
    case-insensitively, whitespace-insensitively, or via its slug form. */
const exactKey = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** The built-in local lexical engine (free tier — knowledge design v2 R1/R3):
 * keyword retrieval over the host's own store, in the knowledge-owned
 * collections. Honestly keyword-grade — deterministic term-frequency ranking
 * with title/heading boosts, no embeddings, no fuzziness.
 *
 * Intents (LEXICAL INTENTS ruling): `chat` ranks token matches over chunks;
 * `deep` is an honest no-op escalation for a lexical engine (same retrieval —
 * engines behind the wire do real agentic deep search); `schema` is exact
 * term/title lookup over glossary/api docs where empty means not-found.
 * Scores are engine-relative and zero-match queries return zero hits.
 *
 * Zero-config: `knowledge: vendoKnowledge()` — createVendo injects the
 * composed store (server wiring, ENG-360). Pass `{ store }` to keep the
 * knowledge tables in a different database (BYO rule); until a store is
 * bound, operations fail loudly rather than pretending to be an empty corpus.
 */
export function vendoKnowledge(options: { store?: StoreAdapter } = {}): KnowledgeAdapter {
  const store = (): StoreAdapter => {
    if (options.store === undefined) {
      throw new VendoError(
        "validation",
        "vendoKnowledge() has no store bound — pass vendoKnowledge({ store }) or wire it through createVendo, which injects the composed store",
      );
    }
    return options.store;
  };
  const docRows = (): RecordStore => store().records(KNOWLEDGE_DOCS_COLLECTION);
  const chunkRows = (): RecordStore => store().records(KNOWLEDGE_CHUNKS_COLLECTION);

  const visible = (visibility: KnowledgeDoc["visibility"], ctx: KnowledgeContext): boolean =>
    visibility === "public" || ctx.includeInternal === true;

  const kindMatches = (kind: KnowledgeKind, kinds: KnowledgeKind[] | undefined): boolean =>
    kinds === undefined || kinds.includes(kind);

  /** schema intent: exact term/title match over glossary+api docs. */
  async function schemaSearch(query: KnowledgeQuery, ctx: KnowledgeContext, limit: number): Promise<KnowledgeHit[]> {
    const key = exactKey(query.text);
    if (key.length === 0) return [];
    const hits: KnowledgeHit[] = [];
    for (const row of await listAll(docRows())) {
      const doc = row.data as KnowledgeDoc;
      if (doc.kind !== "glossary" && doc.kind !== "api") continue;
      if (!kindMatches(doc.kind, query.kinds) || !visible(doc.visibility, ctx)) continue;
      if (exactKey(doc.title) !== key) continue;
      hits.push({
        ref: { docId: doc.id, title: doc.title, source: doc.source },
        snippet: doc.text.slice(0, SNIPPET_RADIUS * 2).trim(),
        kind: doc.kind,
        visibility: doc.visibility,
        score: 1,
      });
    }
    hits.sort((a, b) => (a.ref.docId < b.ref.docId ? -1 : 1));
    return hits.slice(0, limit);
  }

  const adapter: KnowledgeAdapter = {
    posture: { fetch: true, write: true, visibility: "enforced" },

    async search(query, ctx) {
      const limit = query.limit ?? 10;
      if (query.kinds !== undefined && query.kinds.length === 0) return { hits: [] };
      if (query.intent === "schema") return { hits: await schemaSearch(query, ctx, limit) };

      // chat and deep both take this path: deep is a documented no-op
      // escalation for the lexical engine.
      const tokens = tokenize(query.text);
      if (tokens.length === 0) return { hits: [] };
      const scored: { chunk: ChunkRow; score: number }[] = [];
      // Visibility and kind filter BEFORE ranking (R5): invisible rows never
      // enter the candidate set, so they cannot influence scores or limits.
      for (const row of await listAll(chunkRows())) {
        const chunk = row.data as ChunkRow;
        if (!visible(chunk.visibility, ctx) || !kindMatches(chunk.kind, query.kinds)) continue;
        const body = tokenize(chunk.text);
        const counts = new Map<string, number>();
        for (const token of body) counts.set(token, (counts.get(token) ?? 0) + 1);
        const title = new Set(tokenize(chunk.title));
        const heading = new Set(tokenize(chunk.heading ?? ""));
        let score = 0;
        for (const token of new Set(tokens)) {
          score += counts.get(token) ?? 0;
          if (title.has(token)) score += 3;
          if (heading.has(token)) score += 2;
        }
        if (score > 0) scored.push({ chunk, score });
      }
      scored.sort((a, b) =>
        b.score - a.score
        || (a.chunk.docId < b.chunk.docId ? -1 : a.chunk.docId > b.chunk.docId ? 1 : 0)
        || a.chunk.index - b.chunk.index);
      // limit truncates the ranking, never changes it (R3).
      return {
        hits: scored.slice(0, limit).map(({ chunk, score }) => ({
          ref: { docId: chunk.docId, chunkId: chunk.chunkId, title: chunk.title },
          snippet: snippetAround(chunk.text, tokens),
          kind: chunk.kind,
          visibility: chunk.visibility,
          score,
        })),
      };
    },

    async fetch(ref, ctx) {
      const row = await docRows().get(ref.docId);
      if (row === null) return null;
      const doc = row.data as KnowledgeDoc;
      // A ref is not a capability: internal docs read as unknown (R5).
      if (!visible(doc.visibility, ctx)) return null;
      if (ref.chunkId !== undefined) {
        const chunkRow = await chunkRows().get(ref.chunkId);
        const chunk = chunkRow?.data as ChunkRow | undefined;
        if (chunk !== undefined && chunk.docId === ref.docId) {
          // Read-more: the cited chunk joined with its structural neighbors.
          const siblings = (await listAll(chunkRows(), { doc_id: ref.docId }))
            .map((sibling) => sibling.data as ChunkRow)
            .sort((a, b) => a.index - b.index);
          const window = siblings.filter((sibling) => Math.abs(sibling.index - chunk.index) <= 1);
          return {
            ref: { docId: doc.id, chunkId: chunk.chunkId, title: doc.title, source: doc.source },
            text: window.map((sibling) => sibling.text).join("\n\n"),
            truncated: window.length < siblings.length,
          };
        }
      }
      return { ref: { docId: doc.id, title: doc.title, source: doc.source }, text: doc.text };
    },

    async upsert(docs) {
      for (const doc of docs) {
        const chunks = structuralChunker.chunk(doc);
        const keep = new Set(chunks.map((chunk) => chunk.chunkId));
        // Replace chunk rows: stale rows go first so a re-chunked doc never
        // leaves orphans, then the new rows land, then the doc row — by the
        // time upsert resolves the doc is searchable (frozen invariant).
        for (const stale of await listAll(chunkRows(), { doc_id: doc.id })) {
          if (!keep.has(stale.id)) await chunkRows().delete(stale.id);
        }
        for (const chunk of chunks) {
          const data: ChunkRow = { ...chunk, kind: doc.kind, visibility: doc.visibility, title: doc.title };
          // REFS ruling: chunks ref their doc; knowledge is host-level, so
          // rows deliberately carry no subject_id (subject-erase skips them).
          await chunkRows().put({ id: chunk.chunkId, data: { ...data }, refs: { doc_id: doc.id } });
        }
        await docRows().put({ id: doc.id, data: { ...doc }, refs: { source: doc.source } });
      }
    },

    async remove(docIds) {
      for (const docId of docIds) {
        for (const chunk of await listAll(chunkRows(), { doc_id: docId })) {
          await chunkRows().delete(chunk.id);
        }
        await docRows().delete(docId);
      }
    },

    async status(): Promise<KnowledgeStatus> {
      const byKind: Partial<Record<KnowledgeKind, number>> = {};
      let docs = 0;
      for (const row of await listAll(docRows())) {
        const doc = row.data as KnowledgeDoc;
        docs += 1;
        byKind[doc.kind] = (byKind[doc.kind] ?? 0) + 1;
      }
      return { docs, byKind };
    },
  };

  if (options.store === undefined) storeless.add(adapter);
  return adapter;
}

/** Engines built with no store of their own — the zero-config
    `vendoKnowledge()` form. A WeakSet rather than a marker property so what
    the host holds stays exactly a `KnowledgeAdapter`. */
const storeless = new WeakSet<KnowledgeAdapter>();

/** The composition seam's half of zero-config local knowledge (server.ts
    `selectKnowledge`): hand a store-less `vendoKnowledge()` the store
    createVendo composed. Everything else — an engine the host gave its own
    store, a cloud/BYO/custom adapter — passes through untouched, so this can
    sit unconditionally on the explicit-adapter rung. Hosts never call it;
    it is how `knowledge: vendoKnowledge()` gets the store the docs promise
    without any host plumbing. */
export function bindKnowledgeStore(adapter: KnowledgeAdapter, store: StoreAdapter): KnowledgeAdapter {
  return storeless.has(adapter) ? vendoKnowledge({ store }) : adapter;
}
