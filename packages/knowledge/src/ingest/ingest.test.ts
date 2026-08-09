import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VENDO_KNOWLEDGE_CONFIG_FORMAT,
  globToRegExp,
  ingestSources,
  knowledgeConfigSchema,
  type KnowledgeConfig,
} from "./index.js";
import { parseSourceFile } from "./parse.js";

describe("knowledgeConfigSchema", () => {
  const valid: KnowledgeConfig = {
    format: VENDO_KNOWLEDGE_CONFIG_FORMAT,
    sources: [{ name: "docs", glob: "docs/**/*.md", kind: "docs", visibility: "public" }],
  };

  it("accepts a valid config", () => {
    expect(knowledgeConfigSchema.parse(valid)).toEqual(valid);
  });

  it("rejects unknown keys loudly at both levels (.strict())", () => {
    expect(() => knowledgeConfigSchema.parse({ ...valid, extra: true })).toThrow(/unrecognized/i);
    expect(() => knowledgeConfigSchema.parse({
      ...valid,
      sources: [{ ...valid.sources[0], visibilty: "public" }],
    })).toThrow(/unrecognized/i);
  });

  it("rejects globs that could escape the project root (checker round 1 fix 1 — security)", () => {
    for (const glob of ["../outside/*.md", "docs/../../x/*.md", "/etc/*.conf", "\\\\share\\docs\\*.md", "C:/secrets/*.md"]) {
      expect(() => knowledgeConfigSchema.parse({
        ...valid,
        sources: [{ ...valid.sources[0], glob }],
      }), glob).toThrow(/project root/);
    }
  });

  it("rejects duplicate source names and non-slug names", () => {
    expect(() => knowledgeConfigSchema.parse({
      ...valid,
      sources: [valid.sources[0], { ...valid.sources[0]!, glob: "other/**" }],
    })).toThrow(/duplicate source name/);
    expect(() => knowledgeConfigSchema.parse({
      ...valid,
      sources: [{ ...valid.sources[0], name: "Has Spaces" }],
    })).toThrow(/lowercase slugs/);
  });
});

describe("globToRegExp", () => {
  it("spans directories with ** and stays in-segment with *", () => {
    const deep = globToRegExp("docs/**/*.md");
    expect(deep.test("docs/a.md")).toBe(true);
    expect(deep.test("docs/x/y/a.md")).toBe(true);
    expect(deep.test("docs/a.txt")).toBe(false);
    expect(deep.test("other/a.md")).toBe(false);
    const flat = globToRegExp("*.md");
    expect(flat.test("a.md")).toBe(true);
    expect(flat.test("docs/a.md")).toBe(false);
  });
});

describe("parseSourceFile", () => {
  const source = { name: "glossary", glob: "glossary.md", kind: "glossary", visibility: "public" } as const;

  it("turns a glossary markdown file into one doc per term", () => {
    const docs = parseSourceFile({
      source,
      path: "glossary.md",
      raw: "Intro line (not an entry).\n\n## ACH Transfer\nA bank-to-bank transfer.\n\n## Chargeback\nA disputed charge.\n",
    });
    expect(docs.map((doc) => doc.id)).toEqual([
      "glossary#glossary.md#ach-transfer",
      "glossary#glossary.md#chargeback",
    ]);
    expect(docs[0]).toMatchObject({ kind: "glossary", title: "ACH Transfer", text: "A bank-to-bank transfer." });
  });

  it("parses JSON glossaries in both object and array shapes, failing loudly otherwise", () => {
    const object = parseSourceFile({ source, path: "terms.json", raw: '{"APR": "Annual percentage rate."}' });
    expect(object[0]).toMatchObject({ id: "glossary#terms.json#apr", title: "APR" });
    const array = parseSourceFile({
      source,
      path: "api.json",
      raw: '[{"name": "GET /accounts", "description": "List accounts."}]',
    });
    expect(array[0]).toMatchObject({ title: "GET /accounts", text: "List accounts." });
    expect(() => parseSourceFile({ source, path: "bad.json", raw: '"just a string"' })).toThrow(/bad\.json/);
    expect(() => parseSourceFile({ source, path: "bad2.json", raw: "{" })).toThrow(/invalid JSON/);
  });

  it("fails loudly when two terms slug identically", () => {
    expect(() => parseSourceFile({
      source,
      path: "glossary.md",
      raw: "## API Key\none\n## api-key\ntwo\n",
    })).toThrow(/collide/);
  });

  it("treats a heading-less glossary file as one entry named after the file", () => {
    const docs = parseSourceFile({
      source,
      path: "glossary/pricing-terms.md",
      raw: "Interchange is the fee the card network charges per authorization.\n",
    });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      id: "glossary#glossary/pricing-terms.md#pricing-terms",
      title: "pricing-terms",
      text: "Interchange is the fee the card network charges per authorization.",
    });
  });

  it("yields no docs for a glossary file with nothing in it", () => {
    expect(parseSourceFile({ source, path: "glossary.md", raw: "\n   \n" })).toEqual([]);
  });

  it("names the offending entry when a JSON array element lacks a term or a definition", () => {
    expect(() => parseSourceFile({ source, path: "api.json", raw: '[{"name": "GET /accounts"}]' }))
      .toThrow(/api\.json: entry 0 must carry string term\/name and definition\/description/);
    expect(() => parseSourceFile({ source, path: "api.json", raw: '[{"description": "List accounts."}]' }))
      .toThrow(/entry 0 must carry/);
  });

  it("names the offending term when a JSON object maps it to a non-string", () => {
    expect(() => parseSourceFile({ source, path: "terms.json", raw: '{"APR": {"rate": 1}}' }))
      .toThrow(/terms\.json: value for term "APR" must be a string definition/);
  });

  it("titles a prose doc from its first h1, fence-aware", () => {
    const docs = parseSourceFile({
      source: { name: "docs", glob: "**/*.md", kind: "docs", visibility: "public" },
      path: "guide.md",
      raw: "```\n# fenced, not the title\n```\n\n# Real Title\nBody.\n",
    });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe("Real Title");
    expect(docs[0]!.id).toBe("docs#guide.md");
  });

  it("falls back from an h1 to the first heading of any level, then to the file name", () => {
    const prose = { name: "docs", glob: "**/*.md", kind: "docs", visibility: "public" } as const;
    const h2Only = parseSourceFile({ source: prose, path: "guide.md", raw: "## Getting started\nBody.\n" });
    expect(h2Only[0]!.title).toBe("Getting started");
    const headingless = parseSourceFile({
      source: prose,
      path: "docs/release-notes.md",
      raw: "Body with no heading at all.\n",
    });
    expect(headingless[0]!.title).toBe("release-notes");
  });
});

describe("ingestSources", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vendo-knowledge-ingest-"));
    await mkdir(join(root, "docs", "deep"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), "# Guide\nHello.\n");
    await writeFile(join(root, "docs", "deep", "faq.md"), "# FAQ\nAnswers.\n");
    await writeFile(join(root, "docs", "notes.txt"), "not matched\n");
    await writeFile(join(root, "glossary.md"), "## Term A\nAlpha.\n## Term B\nBeta.\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const config: KnowledgeConfig = {
    format: VENDO_KNOWLEDGE_CONFIG_FORMAT,
    sources: [
      { name: "docs", glob: "docs/**/*.md", kind: "docs", visibility: "public" },
      { name: "glossary", glob: "glossary.md", kind: "glossary", visibility: "internal" },
    ],
  };

  it("expands globs per source and parses per kind, with stable ids across runs", async () => {
    const first = await ingestSources(config, { root });
    expect(first.map((doc) => doc.id)).toEqual([
      "docs#docs/deep/faq.md",
      "docs#docs/guide.md",
      "glossary#glossary.md#term-a",
      "glossary#glossary.md#term-b",
    ]);
    expect(first.find((doc) => doc.id === "glossary#glossary.md#term-a")).toMatchObject({
      visibility: "internal",
      kind: "glossary",
      source: "glossary.md",
    });
    const second = await ingestSources(config, { root });
    expect(second).toEqual(first);
  });

  it("skips a source whose directory does not exist instead of failing the whole ingest", async () => {
    // A renamed or not-yet-created folder in .vendo/knowledge.json matches
    // nothing; the sources that do exist still ingest.
    const withMissing: KnowledgeConfig = {
      ...config,
      sources: [
        { name: "handbook", glob: "handbook/**/*.md", kind: "docs", visibility: "public" },
        config.sources[1]!,
      ],
    };
    const docs = await ingestSources(withMissing, { root });
    expect(docs.map((doc) => doc.id)).toEqual([
      "glossary#glossary.md#term-a",
      "glossary#glossary.md#term-b",
    ]);
  });

  it("rejects an invalid config loudly instead of ingesting a subset", async () => {
    await expect(ingestSources({ ...config, sources: [{ ...config.sources[0]!, typo: 1 } as never] }, { root }))
      .rejects.toThrow(/unrecognized/i);
  });

  it("never ingests files outside the root — the checker's ../outside/secret.md probe (fix 1)", async () => {
    // Sibling of the project root, exactly the checker's layout.
    const parent = await mkdtemp(join(tmpdir(), "vendo-knowledge-escape-"));
    const projectRoot = join(parent, "project");
    await mkdir(join(parent, "outside"), { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(parent, "outside", "secret.md"), "# Secret\ntop secret\n");
    try {
      const escaping: KnowledgeConfig = {
        format: VENDO_KNOWLEDGE_CONFIG_FORMAT,
        sources: [{ name: "evil", glob: "../outside/secret.md", kind: "docs", visibility: "public" }],
      };
      await expect(ingestSources(escaping, { root: projectRoot })).rejects.toThrow(/project root/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
