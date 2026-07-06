import { promises as fs } from "node:fs";
import path from "node:path";
import type { LanguageModel } from "ai";
import { writeGenerated } from "../fsx.js";
import { addDevDependency } from "../next-wiring.js";
import { scanComponents, type ComponentCandidate } from "./scan.js";
import { analyzeComponent, proposeComponents } from "./analyze.js";
import { writeComponent, entrySource, viteConfigSource, aliasesFromTsconfigPaths } from "./codegen.js";
import type { Interactor } from "../interact.js";
import { disambiguatedLabels, truncateHint } from "../picker-util.js";

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
  /**
   * How many candidates were actually offered to the catalog picker — the
   * filtered set (unwrapped-only on an additive re-run; all of them under
   * `--force`). Differs from {@link candidates} (total discovered) whenever a
   * re-run finds already-wrapped components, so telemetry's "offered" count
   * stays honest instead of over-reporting on refresh.
   */
  offered: number;
  written: string[];
  excluded: Array<{ file: string; reason: string }>;
  failed: Array<{ file: string; error: string }>;
  /** Wrappable candidates offered in the picker but left unchecked (component names). */
  deselected?: string[];
  /** The picker was cancelled (Ctrl-C) — the step was skipped, nothing generated. */
  pickerCancelled?: boolean;
}

export interface ExtractComponentsOptions {
  force: boolean;
  /**
   * May this run show the interactive catalog picker? When false/omitted every
   * (unwrapped) candidate is generated — the non-interactive default, and the
   * pre-picker behavior. When true, a single batch proposal call annotates the
   * candidates and the picker (via `interactor`) selects which ones generate.
   */
  interactive?: boolean;
  /** The picker seam. Required to actually prompt (only consulted when `interactive`). */
  interactor?: Interactor;
}

export async function extractComponents(
  targetDir: string,
  model: LanguageModel,
  opts: ExtractComponentsOptions,
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

  // PROPOSE + SELECT. Only interactive runs with candidates reach here: the
  // already-wrapped filter above runs FIRST (users never see wrapped ones), a
  // zero-candidate run spends no LLM budget, and non-interactive runs generate
  // everything (preserving pre-picker behavior). Cancel (null) skips the step.
  let toGenerate = candidates;
  let deselected: string[] | undefined;
  let pickerCancelled = false;
  if (candidates.length > 0 && opts.interactive && opts.interactor) {
    const proposal = await proposeComponents(candidates, model);
    excluded.push(...proposal.excluded);
    // Labels are component names, never paths — except when two files export
    // the same name, where bare names would render identical rows (and an
    // ambiguous deselected report line): duplicates get the rel path appended,
    // unique names stay bare (shared with the remix picker via picker-util).
    const labelFor = disambiguatedLabels(
      proposal.wrappable.map((w) => w.candidate),
      (c) => c.exportName,
      (c) => c.relFile,
    );
    const selection = await opts.interactor.multiSelect({
      message: "Select components to wrap for the Vendo sandbox catalog",
      options: proposal.wrappable.map((w) => ({
        // value is the relFile (unique, invisible); the label is the component name.
        value: w.candidate.relFile,
        label: labelFor(w.candidate),
        // Reasons have no schema max and clack renders hints inline — cap them.
        hint: truncateHint(w.reason),
      })),
      initialValues: proposal.wrappable.map((w) => w.candidate.relFile),
      // Empty selection is a legitimate answer (generate nothing) — distinct
      // from cancel (null), which skips the step.
      required: false,
    });
    if (selection === null) {
      pickerCancelled = true;
      toGenerate = [];
    } else {
      const picked = new Set(selection);
      toGenerate = proposal.wrappable.filter((w) => picked.has(w.candidate.relFile)).map((w) => w.candidate);
      deselected = proposal.wrappable
        .filter((w) => !picked.has(w.candidate.relFile))
        .map((w) => labelFor(w.candidate));
    }
  }

  for (const candidate of toGenerate) {
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
    // The generated bundle build (vite.config.mts → entry.ts) imports
    // @vendoai/stage/build + vite + the react plugin. Add them so a manual /
    // deferred `vite build` in .vendo/components/ resolves. Best-effort:
    // missing/unparsable package.json is left alone.
    await addComponentBuildDeps(targetDir);
  }
  return {
    candidates: all.length,
    offered: candidates.length,
    written,
    excluded,
    failed,
    ...(deselected && deselected.length > 0 ? { deselected } : {}),
    ...(pickerCancelled ? { pickerCancelled: true } : {}),
  };
}

const COMPONENT_BUILD_DEPS = ["@vendoai/stage", "vite", "@vitejs/plugin-react"];

async function addComponentBuildDeps(targetDir: string): Promise<void> {
  const pkgPath = path.join(targetDir, "package.json");
  let raw: string;
  try {
    raw = await fs.readFile(pkgPath, "utf8");
  } catch {
    return;
  }
  let out = raw;
  for (const dep of COMPONENT_BUILD_DEPS) out = addDevDependency(out, dep, "latest") ?? out;
  if (out !== raw) await fs.writeFile(pkgPath, out);
}
