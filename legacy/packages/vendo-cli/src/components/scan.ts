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
  /** every exported PascalCase symbol — the safe import universe for codegen */
  exportNames: string[];
  source: string;
}

// export function/const/class Foo — the declaration form.
const EXPORT_DECL_RE = /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
// export { A, B as C } — the clause/re-export form (shadcn declares
// `const Button = React.forwardRef(...)` then `export { Button, buttonVariants }`).
const EXPORT_CLAUSE_RE = /export\s*\{([^}]*)\}/g;
const MAX_CANDIDATES = 25;
const MAX_FILE_BYTES = 40_000;

/** Every exported symbol that looks like a component (PascalCase), in source
 *  order, deduped. Recognizes both `export function/const Name` and the
 *  `export { Name, X as Y }` re-export shape; lowercase/util exports are skipped. */
function exportedComponentNames(source: string): string[] {
  const hits: Array<{ index: number; name: string }> = [];
  for (const m of source.matchAll(EXPORT_DECL_RE)) hits.push({ index: m.index!, name: m[1]! });
  for (const m of source.matchAll(EXPORT_CLAUSE_RE)) {
    for (const part of m[1]!.split(",")) {
      const seg = part.trim().replace(/^type\s+/, "");
      if (!seg) continue;
      const name = (seg.split(/\s+as\s+/).pop() ?? seg).trim(); // `A as B` exports B
      hits.push({ index: m.index!, name });
    }
  }
  const seen = new Set<string>();
  const names: string[] = [];
  for (const { name } of hits.sort((a, b) => a.index - b.index)) {
    if (/^[A-Z][A-Za-z0-9]*$/.test(name) && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

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
  // Design-system primitives (components/ui/) are the best wrap candidates —
  // scan them first so the candidate cap never drops them.
  files.sort((a, b) => Number(b.includes("/ui/")) - Number(a.includes("/ui/")) || a.localeCompare(b));
  const candidates: ComponentCandidate[] = [];
  for (const file of files) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const source = await fs.readFile(file, "utf8");
    if (source.length > MAX_FILE_BYTES) continue; // giant files are not reusable primitives
    const exportNames = exportedComponentNames(source);
    if (exportNames.length === 0) continue;
    candidates.push({
      file,
      relFile: path.relative(targetDir, file).replace(/\\/g, "/"),
      exportName: exportNames[0]!,
      exportNames,
      source,
    });
  }
  return candidates;
}
