import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  expectedGraphqlToolInventorySchema,
  expectedHttpToolInventorySchema,
  expectedServerActionToolInventorySchema,
  expectedTrpcToolInventorySchema,
} from "../expectations.js";

/**
 * `corpus/expectations/<repo>/ai-expected.json` — ground-truth labels for the
 * AI extraction matrix. Entries reuse the binding-identity conventions of
 * `expected.json` (method+path, tRPC procedure, GraphQL operation,
 * server-action module#export) and add the judgment the AI pass is scored on:
 *
 * - `risk`: the correct semantic risk grade for the tool.
 * - `critical`: the tool is irreversible and must carry a critical mark.
 * - `wake`: only meaningful for statically-unclassifiable (disabled) tools.
 *   `false` pins a tool that must stay asleep; when omitted, a disabled tool
 *   with a labeled risk is expected to be woken with that grade.
 */

const riskSchema = z.enum(["read", "write", "destructive"]);

const aiJudgmentFields = {
  risk: riskSchema,
  critical: z.boolean().optional(),
  wake: z.boolean().optional(),
};

export const aiExpectedToolSchema = z.union([
  expectedHttpToolInventorySchema.omit({ readOrWrite: true }).extend(aiJudgmentFields).strict(),
  expectedTrpcToolInventorySchema.omit({ readOrWrite: true }).extend(aiJudgmentFields).strict(),
  expectedGraphqlToolInventorySchema.omit({ readOrWrite: true }).extend(aiJudgmentFields).strict(),
  expectedServerActionToolInventorySchema.omit({ readOrWrite: true }).extend(aiJudgmentFields).strict(),
]);

export const repoAiExpectationsSchema = z
  .object({
    version: z.literal(1),
    tools: z.array(aiExpectedToolSchema),
  })
  .strict();

export type AiExpectedTool = z.infer<typeof aiExpectedToolSchema>;
export type RepoAiExpectations = z.infer<typeof repoAiExpectationsSchema>;

/** Same key format as expectations.ts `expectedToolIdentity`, over the
 * ai-expected shape (which drops `readOrWrite`). */
export function aiExpectedToolIdentity(item: AiExpectedTool): string {
  if ("procedure" in item) return `trpc\t${item.procedure}`;
  if ("operation" in item) return `graphql\t${item.operation}`;
  if ("module" in item) return `server-action\t${item.module}#${item.export}`;
  return `${item.method}\t${item.path}`;
}

export function repoAiExpectedPath(expectationsRoot: string, repoName: string): string {
  return path.join(expectationsRoot, repoName, "ai-expected.json");
}

export function parseRepoAiExpectations(value: unknown): RepoAiExpectations {
  return repoAiExpectationsSchema.parse(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function loadRepoAiExpectations(
  expectationsRoot: string,
  repoName: string,
): Promise<RepoAiExpectations | null> {
  let raw: string;
  try {
    raw = await readFile(repoAiExpectedPath(expectationsRoot, repoName), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  return parseRepoAiExpectations(JSON.parse(raw));
}

const safeRepoNamePattern = /^[a-z0-9][a-z0-9-]*$/;

/** Repos with an ai-expected.json are the default AI-matrix set, mirroring
 * gallery.json discovery. */
export async function discoverAiConfiguredRepoNames(expectationsRoot: string): Promise<string[]> {
  const entries = await readdir(expectationsRoot, { withFileTypes: true });
  const configured: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeRepoNamePattern.test(entry.name)) continue;
    try {
      await access(repoAiExpectedPath(expectationsRoot, entry.name));
      configured.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return configured.sort();
}
