import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAppRoot } from "./app-root.js";
import { loadManifest } from "./manifest.js";
import { createRunContext } from "./run-context.js";
import {
  createLlmEnumerator,
  runUiParityLayer,
  type GenerateTextLike,
  type UiParityLayerRunResult,
} from "./layers/ui-parity.js";

/**
 * Nightly driver for the UI-parity audit layer (ENG-257). It runs AFTER the
 * Layer 1/2 corpus sweep in corpus-nightly.yml, over the checkouts the sweep
 * left in `corpus/.repos/<repo>` (their `.vendo/*` surface already generated),
 * and prints a per-repo frontend/tool coverage report to the job summary.
 *
 * It is LLM-costed and therefore lives ONLY in corpus-nightly.yml, never on the
 * PR path (ci.yml). The diff/coverage logic it drives is unit-tested in
 * layers/ui-parity.test.ts with a mocked enumerator; here the enumeration is
 * the real model via the provider-agnostic seam (BYO ANTHROPIC_API_KEY).
 */

const DEFAULT_MODEL = "claude-sonnet-4-6";

// Resolve ai-SDK modules at runtime without a static import so the harness
// carries no ai-SDK dependency. A non-literal specifier is intentional:
// TypeScript only resolves string-literal import specifiers, so a variable
// specifier keeps typecheck green without an `ai`/`@ai-sdk/anthropic` dep.
async function importDynamic(specifier: string): Promise<Record<string, unknown>> {
  const resolved: string = specifier;
  return import(resolved) as Promise<Record<string, unknown>>;
}

export interface ResolvedModel {
  model: unknown;
  generateText: GenerateTextLike;
}

export async function resolveModel(env: NodeJS.ProcessEnv): Promise<ResolvedModel> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ui-parity nightly needs ANTHROPIC_API_KEY (BYO key) to enumerate frontend capabilities.");
  }
  let ai: Record<string, unknown>;
  let anthropicMod: Record<string, unknown>;
  try {
    ai = await importDynamic("ai");
    anthropicMod = await importDynamic("@ai-sdk/anthropic");
  } catch (error) {
    throw new Error(
      `ai-SDK not available (${error instanceof Error ? error.message : String(error)}); `
        + "install `ai` and `@ai-sdk/anthropic` in corpus/harness to run the audit.",
    );
  }
  const createAnthropic = anthropicMod.createAnthropic as (config: { apiKey: string }) => (model: string) => unknown;
  const generateText = ai.generateText as GenerateTextLike;
  const model = createAnthropic({ apiKey })(env.UI_PARITY_MODEL?.trim() || DEFAULT_MODEL);
  return { model, generateText };
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

function line(label: string, value: string): string {
  return `${label}: ${value}`;
}

function renderRepoReport(repo: string, result: UiParityLayerRunResult): string {
  const { coverage } = result;
  const rows = coverage.entries.map((entry) => {
    const marker = entry.status === "covered" ? "yes" : entry.status === "gap" ? "GAP" : "PHANTOM";
    const tools = entry.matchedTools.length > 0
      ? entry.matchedTools.join(", ")
      : entry.missingTools.length > 0 ? `(claimed: ${entry.missingTools.join(", ")})` : "—";
    return `| ${entry.capability.id} | ${entry.capability.kind} | ${marker} | ${tools} |`;
  });
  return [
    `### ${repo} — coverage ${coverage.coverage.value.toFixed(3)} (${coverage.coverage.passed}/${coverage.coverage.total})`,
    line("surface", `${result.surface.length} enabled tool(s)/compound(s)/brief(s)`),
    line("gaps", coverage.gaps.length === 0 ? "none" : coverage.gaps.map((entry) => entry.capability.id).join(", ")),
    "",
    "| capability | kind | covered | tools |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

export interface UiParityNightlyDeps {
  /** Test seam / provider override; defaults to the BYO-key ai-SDK resolver. */
  resolveModel?: (env: NodeJS.ProcessEnv) => Promise<ResolvedModel>;
}

export async function runUiParityNightly(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  deps: UiParityNightlyDeps = {},
): Promise<number> {
  const manifest = await loadManifest();
  const requested = argv.filter((arg) => !arg.startsWith("-"));
  const context = createRunContext();

  // Degrade gracefully: a missing key or a missing/broken ai-SDK must SKIP the
  // audit with a clear message, never crash the nightly job (Greptile P1).
  let resolved: ResolvedModel;
  try {
    resolved = await (deps.resolveModel ?? resolveModel)(env);
  } catch (error) {
    log(`ui-parity audit skipped: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
  const enumerate = createLlmEnumerator({ model: resolved.model, generateText: resolved.generateText });

  const repos = requested.length > 0
    ? manifest.filter((repo) => requested.includes(repo.name))
    : manifest;

  const reports: string[] = ["## UI-parity coverage (nightly)", ""];
  let audited = 0;
  for (const repo of repos) {
    const appRoot = resolveAppRoot(repo, context.repoDir(repo.name));
    if (!await exists(path.join(appRoot, ".vendo", "tools.json"))) {
      log(`skip ${repo.name}: no generated .vendo/tools.json checkout (run the sweep first)`);
      continue;
    }
    try {
      const result = await runUiParityLayer({
        repoName: repo.name,
        repoDir: appRoot,
        enumerate,
        logsDir: context.logsDir(repo.name),
      });
      audited += 1;
      reports.push(renderRepoReport(repo.name, result));
    } catch (error) {
      log(`ui-parity failed for ${repo.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (audited === 0) reports.push("_No repos had a generated surface to audit._");
  log(reports.join("\n"));
  return 0;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(entry as string) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  runUiParityNightly(process.argv.slice(2), process.env, (message) => { console.log(message); })
    .then((code) => { process.exitCode = code; })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      // Nightly + informational: a driver failure must not fail the whole job.
      process.exitCode = 0;
    });
}
