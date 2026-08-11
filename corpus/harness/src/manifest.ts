import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const gitShaPattern = /^[0-9a-f]{40}$/;
const repoNamePattern = /^[a-z0-9][a-z0-9-]*$/;
const appDirSegmentPattern = /^[A-Za-z0-9._-]+$/;

function relativePosixPathSchema(field: "appDir" | "localPath") {
  return z
    .string()
    .min(1)
    .refine((value) => !value.startsWith("/") && !value.includes("\\"), `${field} must be a relative POSIX path`)
    .refine(
      (value) => value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && appDirSegmentPattern.test(segment)),
      `${field} must contain only relative path segments`,
    );
}

const bootstrapRecipeSchema = z
  .object({
    installCommand: z.string().min(1),
    envTemplate: z.record(z.string(), z.string()),
    typecheckCommand: z.string().min(1).optional(),
    buildCommand: z.string().min(1),
  })
  .strict();

export const manifestEntrySchema = z
  .object({
    name: z.string().regex(repoNamePattern),
    gitUrl: z.string().url().optional(),
    pinnedSha: z.string().regex(gitShaPattern, "pinnedSha must be a 40-character Git SHA").optional(),
    localPath: relativePosixPathSchema("localPath").optional(),
    appDir: relativePosixPathSchema("appDir").optional(),
    framework: z.enum(["next", "express"]).default("next"),
    /** For pinned repos that declare no packageManager of their own, so the
     * ambient corepack pin above `.repos/` cannot leak into the checkout. */
    packageManager: z.string().min(1).optional(),
    license: z.string().min(1),
    tier: z.enum(["broad", "deep"]),
    bootstrap: bootstrapRecipeSchema,
    notes: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.localPath !== undefined) {
      if (entry.gitUrl !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["gitUrl"],
          message: "localPath entries must not define gitUrl",
        });
      }
      if (entry.pinnedSha !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pinnedSha"],
          message: "localPath entries must not define pinnedSha",
        });
      }
    } else {
      if (entry.gitUrl === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["gitUrl"],
          message: "gitUrl is required when localPath is not defined",
        });
      }
      if (entry.pinnedSha === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pinnedSha"],
          message: "pinnedSha is required when localPath is not defined",
        });
      }
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

export type ManifestEntry = z.input<typeof manifestEntrySchema>;
export type CorpusManifest = ManifestEntry[];

export const defaultManifestPath = fileURLToPath(new URL("../../manifest.json", import.meta.url));

export function parseManifest(data: unknown): CorpusManifest {
  return corpusManifestSchema.parse(data);
}

export async function loadManifest(filePath = defaultManifestPath): Promise<CorpusManifest> {
  return parseManifest(JSON.parse(await readFile(filePath, "utf8")));
}
