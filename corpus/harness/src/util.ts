import { access, readFile } from "node:fs/promises";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pathExists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The file's text, or undefined if it is missing or unreadable. */
export async function readOptional(file: string | undefined): Promise<string | undefined> {
  if (!file) return undefined;
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
