import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const gitShaPattern = /^[0-9a-f]{40}$/;
const repoNamePattern = /^[a-z0-9][a-z0-9-]*$/;

const devServerSchema = z
  .object({
    command: z.string().min(1),
    readinessUrl: z.string().url(),
  })
  .strict();

const bootstrapRecipeSchema = z
  .object({
    installCommand: z.string().min(1),
    envTemplate: z.record(z.string(), z.string()),
    seedCommand: z.string().min(1).optional(),
    buildCommand: z.string().min(1),
    devServer: devServerSchema.optional(),
  })
  .strict();

export const manifestEntrySchema = z
  .object({
    name: z.string().regex(repoNamePattern),
    gitUrl: z.string().url(),
    pinnedSha: z.string().regex(gitShaPattern, "pinnedSha must be a 40-character Git SHA"),
    license: z.string().min(1),
    tier: z.enum(["broad", "deep"]),
    bootstrap: bootstrapRecipeSchema,
    notes: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.tier === "deep" && !entry.bootstrap.devServer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bootstrap", "devServer"],
        message: "deep tier entries must define a devServer recipe",
      });
    }
  });

export const corpusManifestSchema = z
  .array(manifestEntrySchema)
  .min(1)
  .superRefine((entries, ctx) => {
    const seen = new Map<string, number>();

    for (const [index, entry] of entries.entries()) {
      const firstIndex = seen.get(entry.name);
      if (firstIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "name"],
          message: `Duplicate corpus repo name "${entry.name}" also appears at index ${firstIndex}`,
        });
      } else {
        seen.set(entry.name, index);
      }
    }
  });

export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
export type CorpusManifest = z.infer<typeof corpusManifestSchema>;

export const defaultManifestPath = fileURLToPath(new URL("../../manifest.json", import.meta.url));

export function parseManifest(data: unknown): CorpusManifest {
  return corpusManifestSchema.parse(data);
}

export async function loadManifest(filePath = defaultManifestPath): Promise<CorpusManifest> {
  return parseManifest(JSON.parse(await readFile(filePath, "utf8")));
}
