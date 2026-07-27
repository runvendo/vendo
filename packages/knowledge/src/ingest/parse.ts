import type { KnowledgeDoc } from "@vendoai/core";
import type { KnowledgeSourceConfig } from "./config.js";
import { normalizeText, splitHeadingSections } from "./markdown.js";

/** Deterministic id fragment for a glossary/api term. */
export const termSlug = (term: string): string =>
  term.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const stem = (path: string): string => {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
};

/** Deterministic doc id: `<source>#<root-relative-path>` (terms append
    `#<term-slug>`). Stable across runs by construction — no timestamps, no
    randomness — so the hash manifest can diff runs. */
export const docId = (sourceName: string, path: string): string => `${sourceName}#${path}`;

interface TermEntry {
  term: string;
  body: string;
}

/** Glossary/api markdown: every heading (any level, fence-aware) defines one
    term; its body is the definition. Text before the first heading is
    front-matter, not an entry. A file with no headings is one entry named
    after the file. */
function markdownTerms(path: string, text: string): TermEntry[] {
  const sections = splitHeadingSections(text).filter((section) => section.level > 0);
  if (sections.length === 0) {
    return text.trim().length === 0 ? [] : [{ term: stem(path), body: text.trim() }];
  }
  return sections.map((section) => ({
    term: section.heading,
    body: section.lines.slice(1).join("\n").trim(),
  }));
}

/** Glossary/api JSON: either `{ "term": "definition" }` or
    `[{ term|name, definition|description }]`. Anything else fails loudly —
    a silently skipped file is a corpus hole nobody notices. */
function jsonTerms(path: string, text: string): TermEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Array.isArray(parsed)) {
    return parsed.map((entry, index) => {
      const record = entry as Record<string, unknown>;
      const term = record?.term ?? record?.name;
      const body = record?.definition ?? record?.description;
      if (typeof term !== "string" || term.length === 0 || typeof body !== "string") {
        throw new Error(`${path}: entry ${index} must carry string term/name and definition/description`);
      }
      return { term, body };
    });
  }
  if (parsed !== null && typeof parsed === "object") {
    return Object.entries(parsed as Record<string, unknown>).map(([term, body]) => {
      if (typeof body !== "string") {
        throw new Error(`${path}: value for term ${JSON.stringify(term)} must be a string definition`);
      }
      return { term, body };
    });
  }
  throw new Error(`${path}: expected a term→definition object or an array of term entries`);
}

/** Parses one source file into normalized docs. Prose (`docs`) files become
    one doc titled by their first heading; glossary/api files become one doc
    PER TERM (id `<source>#<path>#<term-slug>`) so schema-intent lookup and
    per-entry chunking get exact units to work with. */
export function parseSourceFile(input: {
  source: KnowledgeSourceConfig;
  /** Root-relative, forward-slash path. */
  path: string;
  raw: string;
}): KnowledgeDoc[] {
  const { source, path } = input;
  const text = normalizeText(input.raw);
  const base = { kind: source.kind, visibility: source.visibility, source: path } as const;

  if (source.kind === "docs") {
    if (text.trim().length === 0) return [];
    const sections = splitHeadingSections(text);
    const title = sections.find((section) => section.level === 1)?.heading
      ?? sections.find((section) => section.level > 0)?.heading
      ?? stem(path);
    return [{ ...base, id: docId(source.name, path), title, text }];
  }

  const entries = path.toLowerCase().endsWith(".json") ? jsonTerms(path, text) : markdownTerms(path, text);
  const seen = new Set<string>();
  return entries.map((entry) => {
    const slug = termSlug(entry.term);
    if (slug.length === 0) throw new Error(`${path}: term ${JSON.stringify(entry.term)} slugs to nothing`);
    if (seen.has(slug)) {
      throw new Error(`${path}: terms collide on slug ${JSON.stringify(slug)} — rename one so ids stay unique`);
    }
    seen.add(slug);
    return { ...base, id: `${docId(source.name, path)}#${slug}`, title: entry.term, text: entry.body };
  });
}
