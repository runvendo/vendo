import { z } from "zod";
import {
  knowledgeKindSchema,
  knowledgeVisibilitySchema,
  type KnowledgeKind,
  type KnowledgeVisibility,
} from "@vendoai/core";

/** The `.vendo/knowledge.json` format tag (knowledge design v2, developer
    door). An ingestion INPUT like tools.json — deliberately NOT a config
    surface (push/pull semantics don't apply). */
export const VENDO_KNOWLEDGE_CONFIG_FORMAT = "vendo/knowledge@1" as const;

/** One local source: a glob of files sharing a kind and a visibility tier.
    `name` namespaces every doc id the source produces (`<name>#<path>`), so
    renaming a source re-mints its corpus ids — sync treats that as
    remove + re-add. */
export interface KnowledgeSourceConfig {
  name: string;
  /** Root-relative glob (`docs/**\/*.md`). `**` spans directories; `*` and
      `?` stay within one path segment. */
  glob: string;
  kind: KnowledgeKind;
  visibility: KnowledgeVisibility;
}

export interface KnowledgeConfig {
  format: typeof VENDO_KNOWLEDGE_CONFIG_FORMAT;
  sources: KnowledgeSourceConfig[];
}

/** Checker round 1 fix 1 (SECURITY): a source glob must stay inside the
    project root — ingestion runs with the developer's filesystem rights, so
    an absolute or `..`-escaping pattern would sync arbitrary readable files
    into the corpus. Rejected loudly here (the CLI's `add` and every
    ingestSources call validate through this schema); the directory walk
    clamps to root as a second layer. */
const rootRelativeGlob = z.string().min(1)
  .refine((glob) => !/^([/\\]|[A-Za-z]:)/.test(glob), {
    message: "source globs must be relative to the project root, not absolute paths",
  })
  .refine((glob) => !glob.split(/[/\\]/).includes(".."), {
    message: "source globs must not escape the project root ('..' segments are not allowed)",
  });

/** Names are id namespaces, so they keep to a slug grammar and must be
    unique. Strict because hand edits must fail loudly rather than disappear
    on parse (the catalog-file rule). */
export const knowledgeSourceConfigSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "source names are lowercase slugs (a-z, 0-9, -)"),
  glob: rootRelativeGlob,
  kind: knowledgeKindSchema,
  visibility: knowledgeVisibilitySchema,
}).strict() satisfies z.ZodType<KnowledgeSourceConfig>;

export const knowledgeConfigSchema = z.object({
  format: z.literal(VENDO_KNOWLEDGE_CONFIG_FORMAT),
  sources: z.array(knowledgeSourceConfigSchema),
}).strict().superRefine((config, context) => {
  const names = new Set<string>();
  for (const [index, source] of config.sources.entries()) {
    if (names.has(source.name)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate source name ${source.name}`,
        path: ["sources", index, "name"],
      });
    }
    names.add(source.name);
  }
}) satisfies z.ZodType<KnowledgeConfig>;
