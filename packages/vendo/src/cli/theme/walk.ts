import { promises as fs } from "node:fs";
import path from "node:path";

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".next"]);

/** Bounded, deterministic source walk that avoids generated dependency trees. */
export async function walk(
  root: string,
  keep: (relativePath: string) => boolean,
  maxFiles = 5_000,
): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP_DIRECTORIES.has(entry.name)) await visit(full);
      } else if (keep(path.relative(root, full))) {
        files.push(full);
      }
    }
  }
  await visit(root);
  return files.sort();
}
