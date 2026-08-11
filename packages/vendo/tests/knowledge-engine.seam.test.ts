import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeContext, KnowledgeDoc, StoreOps } from "@vendoai/core";
import {
  KNOWLEDGE_CHUNKS_COLLECTION,
  KNOWLEDGE_DOCS_COLLECTION,
  vendoKnowledge,
} from "@vendoai/knowledge";
import { createStore, createStoreOps, type VendoStore } from "@vendoai/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The knowledge drawers' ENGINE SEAM.
 *
 * `vendoKnowledge` reaches `vendo_knowledge_docs` and `vendo_knowledge_chunks`
 * through `ops.engine.*` now, either the `StoreOps` surface the host passed or
 * `engineOverAdapter` over the bare adapter. Both halves are real here: the
 * write goes through the engine's own upsert into a real PGlite store, and the
 * read comes back BOTH through the engine's retrieval (search) and through the
 * store's own routed door for those dedicated tables — so a write that never
 * landed, or landed somewhere the store does not serve, fails the test instead
 * of round-tripping through one mocked side.
 *
 * One store for the whole file, torn down at the end: each case writes its own
 * doc, asserts on that doc by id, and removes it. Booting an embedded Postgres
 * per case cost more wall clock than the test timeout allows on a busy machine.
 */

let dataDir: string;
let store: VendoStore;
let ops: StoreOps;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "vendo-knowledge-engine-"));
  store = createStore({ dataDir });
  await store.ensureSchema();
  ops = createStoreOps(store);
});

afterAll(async () => {
  await store.close();
  await rm(dataDir, { recursive: true, force: true });
});

const ctx: KnowledgeContext = { principal: { kind: "user", subject: "user_knowledge_engine" } };

/** A doc whose body carries a token no other case's query matches, so a shared
    store cannot let one case's rows answer another's search. */
const docWith = (token: string): KnowledgeDoc => ({
  id: `docs#${token}.md`,
  title: `Refund policy ${token}`,
  kind: "docs",
  visibility: "public",
  source: `docs/${token}.md`,
  text: `# Refund policy\nRefunds tagged ${token} are processed within five business days.`,
});

describe("vendoKnowledge — engine seam over a real store", () => {
  it("writes and reads its drawers through the ops surface the host passed", async () => {
    const doc = docWith("alpha");
    const knowledge = vendoKnowledge({ store, ops });

    await knowledge.upsert!([doc]);

    // Product read path: retrieval and read-more off the rows just written.
    const { hits } = await knowledge.search({ text: "refunds tagged alpha" }, ctx);
    expect(hits.map((hit) => hit.ref.docId)).toEqual([doc.id]);
    expect(hits[0]!.ref.source).toBe(doc.source);
    await expect(knowledge.fetch!({ docId: doc.id }, ctx)).resolves.toMatchObject({ text: doc.text });

    // Store read path: the same rows through the store's own routed door for
    // these dedicated tables.
    await expect(ops.engine.get(KNOWLEDGE_DOCS_COLLECTION, doc.id)).resolves.not.toBeNull();
    const chunks = await ops.engine.list(KNOWLEDGE_CHUNKS_COLLECTION, { refs: { doc_id: doc.id } });
    expect(chunks.records.length).toBeGreaterThan(0);

    await knowledge.remove!([doc.id]);
    await expect(ops.engine.get(KNOWLEDGE_DOCS_COLLECTION, doc.id)).resolves.toBeNull();
    await expect(ops.engine.list(KNOWLEDGE_CHUNKS_COLLECTION, { refs: { doc_id: doc.id } }))
      .resolves.toMatchObject({ records: [] });
  });

  /** The discriminator: with `store` unset there is no adapter to fall back to,
      so this only passes if the `ops` slot is genuinely the door. */
  it("reaches its drawers through ops alone, with no adapter to fall back to", async () => {
    const doc = docWith("beta");
    const knowledge = vendoKnowledge({ ops });

    await knowledge.upsert!([doc]);

    const { hits } = await knowledge.search({ text: "refunds tagged beta" }, ctx);
    expect(hits.map((hit) => hit.ref.docId)).toEqual([doc.id]);
    await expect(ops.engine.get(KNOWLEDGE_DOCS_COLLECTION, doc.id)).resolves.not.toBeNull();

    await knowledge.remove!([doc.id]);
  });

  it("serves the same drawers off a bare adapter, with no ops passed", async () => {
    const doc = docWith("gamma");
    const knowledge = vendoKnowledge({ store });

    await knowledge.upsert!([doc]);

    const { hits } = await knowledge.search({ text: "refunds tagged gamma" }, ctx);
    expect(hits.map((hit) => hit.ref.docId)).toEqual([doc.id]);
    // Written through `engineOverAdapter`'s record door, read back through the
    // store's ops door: the fallback lands in the very same tables.
    await expect(ops.engine.get(KNOWLEDGE_DOCS_COLLECTION, doc.id)).resolves.not.toBeNull();

    await knowledge.remove!([doc.id]);
    await expect(ops.engine.get(KNOWLEDGE_DOCS_COLLECTION, doc.id)).resolves.toBeNull();
  });
});
