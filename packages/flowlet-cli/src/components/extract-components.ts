import path from "node:path";
import type { LanguageModel } from "ai";
import { writeGenerated } from "../fsx.js";
import { scanComponents } from "./scan.js";
import { analyzeComponent } from "./analyze.js";
import { writeComponent, entrySource, viteConfigSource } from "./codegen.js";

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
): Promise<ComponentsSummary> {
  const candidates = await scanComponents(targetDir);
  const written: string[] = [];
  const excluded: ComponentsSummary["excluded"] = [];
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
        // One repair round-trip: hand the codegen error back to the model.
        const feedback = codegenErr instanceof Error ? codegenErr.message : String(codegenErr);
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
    await writeGenerated(path.join(targetDir, ".flowlet/components/entry.ts"), entrySource(written), opts);
    await writeGenerated(path.join(targetDir, ".flowlet/components/vite.config.ts"), viteConfigSource(), opts);
  }
  return { candidates: candidates.length, written, excluded, failed };
}
