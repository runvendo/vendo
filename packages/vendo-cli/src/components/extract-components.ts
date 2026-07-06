import { promises as fs } from "node:fs";
import path from "node:path";
import type { LanguageModel } from "ai";
import { writeGenerated } from "../fsx.js";
import { scanComponents, type ComponentCandidate } from "./scan.js";
import { analyzeComponent } from "./analyze.js";
import { writeComponent, entrySource, viteConfigSource, aliasesFromTsconfigPaths } from "./codegen.js";

/**
 * Best-effort read of the host tsconfig `paths`. Plain JSON.parse first —
 * comment-stripping regexes corrupt glob strings like "@/*" and "**\/*.ts",
 * so stripping is only a fallback for genuinely commented tsconfigs.
 */
async function hostAliases(targetDir: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(targetDir, "tsconfig.json"), "utf8");
  } catch {
    return {};
  }
  for (const text of [raw, raw.replace(/^\s*\/\/.*$/gm, "")]) {
    try {
      const json = JSON.parse(text);
      return aliasesFromTsconfigPaths(json?.compilerOptions?.paths ?? {});
    } catch {
      // try the next variant
    }
  }
  return {};
}

export interface ComponentsSummary {
  candidates: number;
  written: string[];
  excluded: Array<{ file: string; reason: string }>;
  failed: Array<{ file: string; error: string }>;
}

export async function extractComponents(
  targetDir: string,
  model: LanguageModel,
  opts: { force: boolean },
  /** Wrapper names already present under .vendo/components/ — their candidates
   *  are skipped on additive re-runs (only unwrapped components are proposed). */
  existingComponents: string[] = [],
): Promise<ComponentsSummary> {
  const all = await scanComponents(targetDir);
  const existing = new Set(existingComponents);
  // Wrapper dirs are named after the analyzed export, with a Host prefix when
  // the name collides with a prewired component (see codegen registryName).
  const alreadyWrapped = (c: ComponentCandidate) =>
    c.exportNames.some((n) => existing.has(n) || existing.has(`Host${n}`));
  const candidates = opts.force ? all : all.filter((c) => !alreadyWrapped(c));
  const written: string[] = [];
  const excluded: ComponentsSummary["excluded"] = opts.force
    ? []
    : all
        .filter(alreadyWrapped)
        .map((c) => ({ file: c.relFile, reason: "already wrapped in .vendo/components/ — kept" }));
  const failed: ComponentsSummary["failed"] = [];

  for (const candidate of candidates) {
    try {
      let analysis = await analyzeComponent(candidate, model);
      if (!analysis.include) {
        excluded.push({ file: candidate.relFile, reason: analysis.reason });
        continue;
      }
      try {
        written.push(await writeComponent(targetDir, analysis, candidate, opts));
      } catch (codegenErr) {
        const feedback = codegenErr instanceof Error ? codegenErr.message : String(codegenErr);
        // Not model-fixable (developer-edited output present) — don't burn a paid call.
        if (feedback.includes("already exists")) throw codegenErr;
        // One repair round-trip: hand the codegen error back to the model.
        analysis = await analyzeComponent(candidate, model, feedback);
        if (!analysis.include) {
          excluded.push({ file: candidate.relFile, reason: analysis.reason });
          continue;
        }
        written.push(await writeComponent(targetDir, analysis, candidate, opts));
      }
    } catch (err) {
      failed.push({ file: candidate.relFile, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (written.length > 0) {
    // entry.ts is a generated index over ALL wrapper dirs (existing + new), so
    // it is always regenerated when the set grows.
    const allNames = [...new Set([...existingComponents, ...written])].sort();
    await writeGenerated(path.join(targetDir, ".vendo/components/entry.ts"), entrySource(allNames), {
      ...opts,
      force: true,
    });
    // .mts so vite loads the config as ESM even though .vendo/ has no package.json.
    // Kept if present on additive re-runs — the host may have tuned it.
    await writeGenerated(
      path.join(targetDir, ".vendo/components/vite.config.mts"),
      viteConfigSource(await hostAliases(targetDir)),
      { ...opts, ifExists: "skip" },
    );
  }
  return { candidates: all.length, written, excluded, failed };
}
