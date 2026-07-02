import { promises as fs } from "node:fs";
import path from "node:path";
import { walk } from "../fsx.js";

export interface ComponentCandidate {
  /** absolute path to the source file */
  file: string;
  /** path relative to the target root, forward slashes */
  relFile: string;
  /** first exported PascalCase symbol (the analysis prompt sees the whole file) */
  exportName: string;
  source: string;
}

const EXPORT_RE = /export\s+(?:function|const)\s+([A-Z][A-Za-z0-9]*)/;
const MAX_CANDIDATES = 25;
const MAX_FILE_BYTES = 40_000;

export async function scanComponents(targetDir: string): Promise<ComponentCandidate[]> {
  const files = await walk(
    targetDir,
    (p) => {
      const rel = p.replace(/\\/g, "/");
      return (
        /(^|\/)components\//.test(rel) &&
        rel.endsWith(".tsx") &&
        !/\.(test|spec|stories)\.tsx$/.test(rel)
      );
    },
    2_000,
  );
  const candidates: ComponentCandidate[] = [];
  for (const file of files) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const source = await fs.readFile(file, "utf8");
    if (source.length > MAX_FILE_BYTES) continue; // giant files are not reusable primitives
    const m = source.match(EXPORT_RE);
    if (!m || !m[1]) continue;
    candidates.push({ file, relFile: path.relative(targetDir, file).replace(/\\/g, "/"), exportName: m[1], source });
  }
  return candidates;
}
