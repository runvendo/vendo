import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const THEME_RUBRIC_DIMENSIONS = [
  "background",
  "surface",
  "accent",
  "text",
  "mutedText",
  "radius",
  "fontFamily",
] as const;

export type ThemeRubricDimension = typeof THEME_RUBRIC_DIMENSIONS[number];
export type ReadOrWrite = "read" | "write";
export type ExpectedMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const hexColor = z.string().regex(/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);

export const repoExpectedThemeSchema = z
  .object({
    background: hexColor,
    surface: hexColor,
    accent: hexColor,
    text: hexColor,
    mutedText: hexColor,
    radius: z.union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d+)?px$/)]),
    fontFamily: z.string().min(1),
  })
  .strict();

export const expectedToolInventorySchema = z
  .object({
    name: z.string().min(1),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().regex(/^\/(?!\/)\S*$/),
    readOrWrite: z.enum(["read", "write"]),
  })
  .strict();

export const expectedToolAnnotationSchema = z
  .object({
    name: z.string().min(1),
    mutating: z.boolean(),
    dangerous: z.boolean(),
    idempotent: z.boolean().optional(),
  })
  .strict();

export const expectedComponentAnnotationSchema = z
  .object({
    name: z.string().min(1),
    descriptionIncludes: z.array(z.string().min(1)).default([]),
    props: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const repoExpectationsSchema = z
  .object({
    version: z.literal(1),
    theme: repoExpectedThemeSchema,
    tools: z.array(expectedToolInventorySchema),
    annotations: z.array(expectedToolAnnotationSchema),
    components: z.array(expectedComponentAnnotationSchema).default([]),
  })
  .strict();

export const repoBaselineSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.string().datetime().optional(),
    score: z
      .object({
        passed: z.number().min(0),
        total: z.number().min(0),
        value: z.number().min(0).max(1),
      })
      .strict(),
  })
  .strict();

export type RepoExpectedTheme = z.infer<typeof repoExpectedThemeSchema>;
export type ExpectedToolInventory = z.infer<typeof expectedToolInventorySchema>;
export type ExpectedToolAnnotation = z.infer<typeof expectedToolAnnotationSchema>;
export type ExpectedComponentAnnotation = z.infer<typeof expectedComponentAnnotationSchema>;
export type RepoExpectations = z.infer<typeof repoExpectationsSchema>;
export type RepoBaseline = z.infer<typeof repoBaselineSchema>;

export function repoExpectationsDir(expectationsRoot: string, repoName: string): string {
  return path.join(expectationsRoot, repoName);
}

export function repoExpectedPath(expectationsRoot: string, repoName: string): string {
  return path.join(repoExpectationsDir(expectationsRoot, repoName), "expected.json");
}

export function repoBaselinePath(expectationsRoot: string, repoName: string): string {
  return path.join(repoExpectationsDir(expectationsRoot, repoName), "baseline.json");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

export function parseRepoExpectations(value: unknown): RepoExpectations {
  return repoExpectationsSchema.parse(value);
}

export function parseRepoBaseline(value: unknown): RepoBaseline {
  return repoBaselineSchema.parse(value);
}

export async function loadRepoExpectations(
  expectationsRoot: string,
  repoName: string,
): Promise<RepoExpectations | null> {
  try {
    return parseRepoExpectations(await readJson(repoExpectedPath(expectationsRoot, repoName)));
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function loadRepoBaseline(
  expectationsRoot: string,
  repoName: string,
): Promise<RepoBaseline | null> {
  try {
    return parseRepoBaseline(await readJson(repoBaselinePath(expectationsRoot, repoName)));
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}
