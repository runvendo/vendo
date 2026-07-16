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

const devServerSchema = z
  .object({
    command: z.string().min(1),
    /** True when the dev-server command serves prebuilt output (for example
     * express-host's `node dist/...` start), so boot-oriented commands such as
     * `corpus gallery` must run `buildCommand` first. Self-compiling dev
     * servers (`next dev`, `nest start -w`) leave this unset: `corpus boot`
     * has never built before booting, and repos with a broken upstream
     * baseline build (papermark) can still boot and be captured. */
    requiresBuild: z.boolean().optional(),
    readinessUrl: z.string().url(),
    readinessBodyContains: z.string().min(1).optional(),
    readinessTimeoutMs: z.number().int().positive().optional(),
    readinessIntervalMs: z.number().int().positive().optional(),
  })
  .strict();

const dockerPostgresProvisioningSchema = z
  .object({
    kind: z.literal("docker-postgres"),
    containerName: z.string().min(1),
    image: z.string().min(1),
    hostPort: z.number().int().min(1024).max(65535),
    database: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
    readinessTimeoutMs: z.number().int().positive().optional(),
    readinessIntervalMs: z.number().int().positive().optional(),
  })
  .strict();

/** Redis mirrors the Postgres provisioning shape (docker container + readiness
 * probe). Twenty is deliberately the only Redis boot in the corpus. */
const dockerRedisProvisioningSchema = z
  .object({
    kind: z.literal("docker-redis"),
    containerName: z.string().min(1),
    image: z.string().min(1),
    hostPort: z.number().int().min(1024).max(65535),
    readinessTimeoutMs: z.number().int().positive().optional(),
    readinessIntervalMs: z.number().int().positive().optional(),
  })
  .strict();

const databaseProvisioningSchema = z.discriminatedUnion("kind", [
  dockerPostgresProvisioningSchema,
  dockerRedisProvisioningSchema,
]);

const bootstrapRecipeSchema = z
  .object({
    installCommand: z.string().min(1),
    envTemplate: z.record(z.string(), z.string()),
    seedCommand: z.string().min(1).optional(),
    database: dockerPostgresProvisioningSchema.optional(),
    redis: dockerRedisProvisioningSchema.optional(),
    typecheckCommand: z.string().min(1).optional(),
    buildCommand: z.string().min(1),
    devServer: devServerSchema.optional(),
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

export type ManifestEntry = z.input<typeof manifestEntrySchema>;
export type CorpusManifest = ManifestEntry[];
export type DatabaseProvisioning = z.infer<typeof databaseProvisioningSchema>;

export const defaultManifestPath = fileURLToPath(new URL("../../manifest.json", import.meta.url));

export function parseManifest(data: unknown): CorpusManifest {
  return corpusManifestSchema.parse(data);
}

export async function loadManifest(filePath = defaultManifestPath): Promise<CorpusManifest> {
  return parseManifest(JSON.parse(await readFile(filePath, "utf8")));
}
