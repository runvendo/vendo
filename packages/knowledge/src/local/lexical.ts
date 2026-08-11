import {
  VendoError,
  engineOverAdapter,
  type KnowledgeAdapter,
  type KnowledgeChunk,
  type KnowledgeContext,
  type KnowledgeDoc,
  type KnowledgeHit,
  type KnowledgeKind,
  type KnowledgeQuery,
  type KnowledgeStatus,
  type StoreAdapter,
  type StoreOps,
  type VendoRecord,
} from "@vendoai/core";
import { KNOWLEDGE_CHUNKS_COLLECTION, KNOWLEDGE_DOCS_COLLECTION } from "../collections.js";
import { structuralChunker } from "../ingest/chunker.js";
// Schema intent matches a term on its title case- and whitespace-insensitively,
// which is the same normalization ingest uses to mint the term's id fragment.
// They must agree, so they are one function.
import { termSlug } from "../ingest/parse.js";

/** A stored chunk row: the chunk plus doc fields denormalized at upsert time
    (upsert replaces every chunk of a doc, so they can never go stale) —
    search filters visibility and boosts titles without a per-row doc join.
    `source` is optional on READ only: rows written before it was denormalized
    lack it and hash-based sync never rewrites an unchanged doc, so search
    falls back to the doc row. Upsert always writes it. */
interface ChunkRow extends KnowledgeChunk {
  kind: KnowledgeDoc["kind"];
  visibility: KnowledgeDoc["visibility"];
  title: string;
  source?: string;
}

/** The seven verbs every drawer in this engine is reached through. */
type EngineOps = StoreOps["engine"];

/** Every corpus scan pages with the keyset cursor (page cap 1000), including
    the status() counts. */
async function listAll(engine: EngineOps, collection: string, refs?: Record<string, string>): Promise<VendoRecord[]> {
  const records: VendoRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await engine.list(collection, { ...(refs === undefined ? {} : { refs }), limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
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

/** The built-in local lexical engine (free tier): keyword retrieval over the
 * host's own store, in the knowledge-owned collections. Honestly
 * keyword-grade — deterministic term-frequency ranking with title/heading
 * boosts, no embeddings, no fuzziness.
 *
 * Intents: `chat` ranks token matches over chunks; `deep` is an honest no-op
 * escalation for a lexical engine (same retrieval — engines behind the wire do
 * real agentic deep search); `schema` is exact term/title lookup over
 * glossary/api docs where empty means not-found. Scores are engine-relative
 * and zero-match queries return zero hits.
 *
 * Zero-config: `knowledge: vendoKnowledge()` — createVendo injects the
 * composed store. Pass `{ store }` to keep the knowledge tables in a different
 * database (BYO rule), and `{ ops }` alongside it for that same store's
 * named-operation surface when the composition could resolve one; until an
 * engine is bound, operations fail loudly rather than pretending to be an empty
 * corpus.
 */
export function vendoKnowledge(options: {
  store?: StoreAdapter;
  /** The named-operation surface (`StoreOps`) over that SAME store, when the
   *  composition could resolve one (`selectStoreOps` answers `undefined` for a
   *  store with neither its own ops nor a SQL handle). Both drawers this engine owns — the doc rows and
   *  the chunk rows — are reached through `ops.engine.*`, so the allowlist gate
   *  applies to both. Unset, the same seven verbs are served straight off the
   *  adapter's own record doors (`engineOverAdapter`), which is what a host's
   *  BYO `StoreAdapter` gets. */
  ops?: StoreOps;
} = {}): KnowledgeAdapter {
  /** Resolved per verb, never at construction: an engine with nothing bound
      must fail on the operation, not on `vendoKnowledge()`. */
  const engine = (): EngineOps => {
    if (options.ops !== undefined) return options.ops.engine;
    if (options.store === undefined) {
      throw new VendoError(
        "validation",
        "vendoKnowledge() has no store bound — pass vendoKnowledge({ store }) or wire it through createVendo, which injects the composed store",
      );
    }
    return engineOverAdapter(options.store);
  };

  const visible = (visibility: KnowledgeDoc["visibility"], ctx: KnowledgeContext): boolean =>
    visibility === "public" || ctx.includeInternal === true;

  const kindMatches = (kind: KnowledgeKind, kinds: KnowledgeKind[] | undefined): boolean =>
    kinds === undefined || kinds.includes(kind);

  /** The cited chunk's source, reading through to the doc row for chunks
      written before `source` was denormalized onto the row. */
  const chunkSource = async (chunk: ChunkRow): Promise<string | undefined> =>
    chunk.source
    ?? ((await engine().get(KNOWLEDGE_DOCS_COLLECTION, chunk.docId))?.data as KnowledgeDoc | undefined)?.source;

  /** schema intent: exact term/title match over glossary+api docs. */
  async function schemaSearch(query: KnowledgeQuery, ctx: KnowledgeContext, limit: number): Promise<KnowledgeHit[]> {
    const key = termSlug(query.text);
    if (key.length === 0) return [];
    const hits: KnowledgeHit[] = [];
    for (const row of await listAll(engine(), KNOWLEDGE_DOCS_COLLECTION)) {
      const doc = row.data as KnowledgeDoc;
      if (doc.kind !== "glossary" && doc.kind !== "api") continue;
      if (!kindMatches(doc.kind, query.kinds) || !visible(doc.visibility, ctx)) continue;
      if (termSlug(doc.title) !== key) continue;
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
      // Visibility and kind filter BEFORE ranking: invisible rows never enter
      // the candidate set, so they cannot influence scores or limits.
      for (const row of await listAll(engine(), KNOWLEDGE_CHUNKS_COLLECTION)) {
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
      // limit truncates the ranking, never changes it — so the doc-row
      // fallback for source-less legacy chunks costs at most `limit` gets.
      return {
        hits: await Promise.all(scored.slice(0, limit).map(async ({ chunk, score }) => ({
          ref: { docId: chunk.docId, chunkId: chunk.chunkId, title: chunk.title, source: await chunkSource(chunk) },
          snippet: snippetAround(chunk.text, tokens),
          kind: chunk.kind,
          visibility: chunk.visibility,
          score,
        }))),
      };
    },

    async fetch(ref, ctx) {
      const rows = engine();
      const row = await rows.get(KNOWLEDGE_DOCS_COLLECTION, ref.docId);
      if (row === null) return null;
      const doc = row.data as KnowledgeDoc;
      // A ref is not a capability: internal docs read as unknown.
      if (!visible(doc.visibility, ctx)) return null;
      if (ref.chunkId !== undefined) {
        const chunkRow = await rows.get(KNOWLEDGE_CHUNKS_COLLECTION, ref.chunkId);
        const chunk = chunkRow?.data as ChunkRow | undefined;
        if (chunk !== undefined && chunk.docId === ref.docId) {
          // Read-more: the cited chunk joined with its structural neighbors.
          const siblings = (await listAll(rows, KNOWLEDGE_CHUNKS_COLLECTION, { doc_id: ref.docId }))
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
      const rows = engine();
      for (const doc of docs) {
        const chunks = structuralChunker.chunk(doc);
        const keep = new Set(chunks.map((chunk) => chunk.chunkId));
        // Replace chunk rows: stale rows go first so a re-chunked doc never
        // leaves orphans, then the new rows land, then the doc row — by the
        // time upsert resolves the doc is searchable.
        for (const stale of await listAll(rows, KNOWLEDGE_CHUNKS_COLLECTION, { doc_id: doc.id })) {
          if (!keep.has(stale.id)) await rows.delete(KNOWLEDGE_CHUNKS_COLLECTION, stale.id);
        }
        for (const chunk of chunks) {
          const data: ChunkRow = {
            ...chunk,
            kind: doc.kind,
            visibility: doc.visibility,
            title: doc.title,
            source: doc.source,
          };
          // Chunks ref their doc; knowledge is host-level, so rows deliberately
          // carry no subject_id (subject-erase skips them).
          await rows.put(KNOWLEDGE_CHUNKS_COLLECTION, { id: chunk.chunkId, data, refs: { doc_id: doc.id } });
        }
        await rows.put(KNOWLEDGE_DOCS_COLLECTION, { id: doc.id, data: { ...doc }, refs: { source: doc.source } });
      }
    },

    async remove(docIds) {
      const rows = engine();
      for (const docId of docIds) {
        for (const chunk of await listAll(rows, KNOWLEDGE_CHUNKS_COLLECTION, { doc_id: docId })) {
          await rows.delete(KNOWLEDGE_CHUNKS_COLLECTION, chunk.id);
        }
        await rows.delete(KNOWLEDGE_DOCS_COLLECTION, docId);
      }
    },

    async status(): Promise<KnowledgeStatus> {
      const byKind: Partial<Record<KnowledgeKind, number>> = {};
      let docs = 0;
      for (const row of await listAll(engine(), KNOWLEDGE_DOCS_COLLECTION)) {
        const doc = row.data as KnowledgeDoc;
        docs += 1;
        byKind[doc.kind] = (byKind[doc.kind] ?? 0) + 1;
      }
      return { docs, byKind };
    },
  };

  // Store-less means NOTHING bound: an engine handed only `ops` reaches its
  // drawers, so rebinding it to the composed store would drop the surface the
  // host passed.
  if (options.store === undefined && options.ops === undefined) storeless.add(adapter);
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
