import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { KnowledgeDoc } from "@vendoai/core";
import {
  engineBarsSchema,
  knowledgeEvalDataDir,
  loadFixtureCorpus,
  loadGoldenSet,
  loadRefusalSet,
} from "./data.js";
import { readFile } from "node:fs/promises";

/**
 * T1 — the yardstick exists and is mechanically consistent: strict schema
 * parses of all three data files, plus the referential-integrity contract
 * between the golden/refusal sets and the fixture corpus that the offline
 * memory-engine leg depends on.
 */

const haystack = (doc: KnowledgeDoc) => `${doc.title}\n${doc.text}`.toLowerCase();

describe("knowledge-eval data files", () => {
  it("fixture corpus parses strictly, with unique ids and all three kinds", async () => {
    const corpus = await loadFixtureCorpus();
    const ids = corpus.docs.map((doc) => doc.id);
    expect(new Set(ids).size).toBe(ids.length);

    const kinds = new Set(corpus.docs.map((doc) => doc.kind));
    expect(kinds).toEqual(new Set(["docs", "glossary", "api"]));

    // The GLOSSARY GAP ruling: 8-12 synthesized glossary entries, and
    // reference/* stays kind:api, so the schema-intent lane is testable.
    const glossary = corpus.docs.filter((doc) => doc.kind === "glossary");
    expect(glossary.length).toBeGreaterThanOrEqual(8);
    expect(glossary.length).toBeLessThanOrEqual(12);
    expect(corpus.docs.some((doc) => doc.kind === "api")).toBe(true);

    // Visibility posture is part of the yardstick: some docs must be
    // internal so the public-only default is actually exercised.
    expect(corpus.docs.some((doc) => doc.visibility === "internal")).toBe(true);
  });

  it("doc ids are content-derived slugs, never file paths", async () => {
    const corpus = await loadFixtureCorpus();
    for (const doc of corpus.docs) {
      expect(doc.id).not.toMatch(/[/.]/);
      expect(doc.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it("golden set parses strictly and covers all three kinds and intents", async () => {
    const golden = await loadGoldenSet();
    const ids = golden.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(golden.items.length).toBeGreaterThanOrEqual(50);

    const corpus = await loadFixtureCorpus();
    const byId = new Map(corpus.docs.map((doc) => [doc.id, doc]));
    const coveredKinds = new Set(
      golden.items.flatMap((item) => item.expectedDocIds).map((id) => byId.get(id)?.kind),
    );
    expect(coveredKinds).toEqual(new Set(["docs", "glossary", "api"]));

    const coveredIntents = new Set(golden.items.map((item) => item.intent ?? "chat"));
    expect(coveredIntents).toEqual(new Set(["chat", "deep", "schema"]));
  });

  it("every expectedDocId resolves to a public fixture doc of a matching kind", async () => {
    const [golden, corpus] = await Promise.all([loadGoldenSet(), loadFixtureCorpus()]);
    const byId = new Map(corpus.docs.map((doc) => [doc.id, doc]));

    for (const item of golden.items) {
      for (const docId of item.expectedDocIds) {
        const doc = byId.get(docId);
        expect(doc, `${item.id}: expectedDocId "${docId}" is not in the fixture corpus`).toBeDefined();
        // The offline context never sets includeInternal, so an internal
        // expected doc could never be retrieved — that is an authoring bug.
        expect(doc?.visibility, `${item.id}: expected doc "${docId}" must be public`).toBe("public");
        if (item.kinds !== undefined) {
          expect(item.kinds, `${item.id}: expected doc "${docId}" kind outside the item's kinds filter`)
            .toContain(doc?.kind);
        }
      }
    }
  });

  it("every item is memory-matchable: memoryQuery occurs in each expected doc", async () => {
    const [golden, corpus] = await Promise.all([loadGoldenSet(), loadFixtureCorpus()]);
    const byId = new Map(corpus.docs.map((doc) => [doc.id, doc]));

    for (const item of golden.items) {
      expect(item.memoryQuery, `${item.id}: the per-PR leg needs a memoryQuery`).toBeDefined();
      for (const docId of item.expectedDocIds) {
        const doc = byId.get(docId);
        expect(
          doc !== undefined && haystack(doc).includes(item.memoryQuery!.toLowerCase()),
          `${item.id}: memoryQuery "${item.memoryQuery}" does not occur in "${docId}"`,
        ).toBe(true);
      }
    }
  });

  it("refusal set parses strictly and no phrasing has an answer in the corpus", async () => {
    const [refusals, corpus] = await Promise.all([loadRefusalSet(), loadFixtureCorpus()]);
    const ids = refusals.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(refusals.items.length).toBeGreaterThanOrEqual(15);

    // The memory engine matches by whole-query substring, so substring
    // absence across every public doc proves zero hits for every phrasing.
    const publicDocs = corpus.docs.filter((doc) => doc.visibility === "public");
    for (const item of refusals.items) {
      for (const phrasing of [item.question, ...item.paraphrases]) {
        const hit = publicDocs.find((doc) => haystack(doc).includes(phrasing.toLowerCase()));
        expect(hit, `${item.id}: "${phrasing}" matches doc "${hit?.id}"`).toBeUndefined();
      }
    }
  });

  it("every bars/<engine>.json parses strictly and uses only supported metric keys", async () => {
    const { SUPPORTED_BAR_KEYS } = await import("./run.js");
    const barsDir = path.join(knowledgeEvalDataDir(), "bars");
    const files = (await readdir(barsDir)).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const file of files) {
      const raw: unknown = JSON.parse(await readFile(path.join(barsDir, file), "utf8"));
      const parsed = engineBarsSchema.parse(raw);
      for (const key of Object.keys(parsed.bars)) {
        expect(SUPPORTED_BAR_KEYS.has(key), `${file}: unsupported bar key "${key}"`).toBe(true);
      }
    }
  });
});
