import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { KnowledgeDoc } from "@vendoai/core";
import { knowledgeConfigSchema, type KnowledgeConfig, type KnowledgeSourceConfig } from "./config.js";
import { parseSourceFile } from "./parse.js";

export {
  VENDO_KNOWLEDGE_CONFIG_FORMAT,
  knowledgeConfigSchema,
  knowledgeSourceConfigSchema,
  type KnowledgeConfig,
  type KnowledgeSourceConfig,
} from "./config.js";
export { structuralChunker } from "./chunker.js";
export { parseSourceFile } from "./parse.js";

/** Hand-rolled glob (zero new deps): `**` spans whole path segments, `*` and
    `?` stay within one. No brace/extglob syntax — the config format keeps to
    what this implements, loudly documented rather than silently subset. */
export function globToRegExp(glob: string): RegExp {
  const segments = glob.split("/").filter((segment) => segment.length > 0);
  let pattern = "^";
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (segment === "**") {
      pattern += last ? ".*" : "(?:[^/]+/)*";
      continue;
    }
    pattern += segment
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    if (!last) pattern += "/";
  }
  return new RegExp(`${pattern}$`);
}

/** The literal directory prefix before the first wildcard — the walk root,
    so `docs/**` never scans the whole repo. */
const staticPrefix = (glob: string): string[] => {
  const segments: string[] = [];
  for (const segment of glob.split("/")) {
    if (/[*?]/.test(segment)) break;
    if (segment.length > 0) segments.push(segment);
  }
  // A fully literal glob names a file: its parent is the walk root.
  if (segments.length === glob.split("/").filter((s) => s.length > 0).length) segments.pop();
  return segments;
};

/** Sorted recursive file walk. Dotfiles and node_modules never match — a
    knowledge glob is for authored content, not vendored trees. The walk is
    clamped to `root` (the second layer of the traversal guard: even a pattern
    that slipped past schema validation can never read outside the root). */
async function walkFiles(root: string, prefix: string[]): Promise<string[]> {
  const rootPath = resolve(root);
  const files: string[] = [];
  const visit = async (relative: string[]): Promise<void> => {
    const dir = resolve(rootPath, ...relative);
    if (dir !== rootPath && !dir.startsWith(rootPath + sep)) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // A prefix that doesn't exist matches nothing.
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = [...relative, entry.name];
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path.join("/"));
    }
  };
  await visit(prefix);
  return files;
}

/** The developer door's read half: expands every configured source against
    `root` and parses matches into normalized `KnowledgeDoc`s, deterministic
    order (config order, then path order). Pure aside from reading the files
    it matches; the sync CLI owns diffing and adapter writes. */
export async function ingestSources(
  config: KnowledgeConfig,
  options: { root: string },
): Promise<KnowledgeDoc[]> {
  const parsed = knowledgeConfigSchema.parse(config);
  const docs: KnowledgeDoc[] = [];
  for (const source of parsed.sources) {
    docs.push(...await ingestSource(source, options.root));
  }
  return docs;
}

async function ingestSource(source: KnowledgeSourceConfig, root: string): Promise<KnowledgeDoc[]> {
  const matcher = globToRegExp(source.glob);
  const docs: KnowledgeDoc[] = [];
  for (const path of await walkFiles(root, staticPrefix(source.glob))) {
    if (!matcher.test(path)) continue;
    const raw = await readFile(join(root, path), "utf8");
    docs.push(...parseSourceFile({ source, path, raw }));
  }
  return docs;
}
