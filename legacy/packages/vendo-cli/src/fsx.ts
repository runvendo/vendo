import { promises as fs } from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".vendo", "dist", "dist-sandbox", "build", "coverage", "out",
]);

/** Recursively list files under `root` for which `keep(relPath)` is true. Sorted, capped. */
export async function walk(
  root: string,
  keep: (relPath: string) => boolean,
  maxFiles = 20_000,
): Promise<string[]> {
  const results: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, extraction is best-effort
    }
    for (const e of entries) {
      if (results.length >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await visit(full);
      } else if (keep(path.relative(root, full))) {
        results.push(full);
      }
    }
  }
  await visit(root);
  return results.sort();
}

/**
 * Write a generated artifact. Outputs are developer-editable, so an existing
 * file is never silently clobbered: `force` overwrites unconditionally,
 * re-writing IDENTICAL bytes is a no-op success (resume support), and for
 * DIFFERENT content `ifExists` picks the policy — "error" (the fail-closed
 * default) throws, "skip" leaves the file untouched. Returns whether it wrote.
 */
export async function writeGenerated(
  file: string,
  content: string,
  opts: { force: boolean; ifExists?: "error" | "skip" },
): Promise<boolean> {
  if (!opts.force) {
    let existing: string | null = null;
    try {
      existing = await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (existing !== null) {
      // Identical bytes: re-running init after a mid-run failure re-writes the
      // same content — treat as a no-op success (resume support). Different
      // content follows `ifExists`: "skip" leaves the file, "error" (default)
      // throws so hand-edits are never silently clobbered.
      if (existing === content) return false;
      if ((opts.ifExists ?? "error") === "skip") return false;
      throw new Error(`${file} already exists — outputs are developer-editable; re-run with --force to overwrite`);
    }
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return true;
}
