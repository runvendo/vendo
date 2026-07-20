import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { LanguageModel } from "ai";
import { runRefine, type RefineChange, type RefineResult, type RefineTranscript } from "../refine.js";
import { consoleOutput, exists, writeText, type Output } from "./shared.js";

/**
 * `vendo refine` — the CLI surface of the refine engine (ENG-250). Extraction
 * stays a build step (sync); refine is explicitly a COMMAND: it proposes
 * agent-layer artifacts as reviewable diffs and applies them only on approval.
 */

export interface RefineCommandOptions {
  targetDir: string;
  url?: string;
  modelImport?: string;
  /** Non-interactive interview answers (`--ask`, repeatable). */
  asks?: string[];
  /** Approve every displayed diff without prompting. */
  yes?: boolean;
  output?: Output;
  fetchImpl?: typeof fetch;
  /** Test seam: skip model resolution. */
  model?: LanguageModel;
  confirm?: (change: { path: string; diff: string }) => Promise<boolean>;
  interview?: (questions: string[]) => Promise<string[]>;
  env?: Record<string, string | undefined>;
}

const INTERVIEW_QUESTIONS = [
  "What should users be able to ask the agent for that today's tools can't do in one step? (Enter to skip)",
  "Any tools that look mislabeled, misdescribed, or that should be disabled? (Enter to skip)",
];

/** Default model in the starter module `vendo init` writes — kept in sync. */
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

async function importHostModule(root: string, specifier: string): Promise<Record<string, unknown>> {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {
    const url = specifier.startsWith("file:") ? specifier : pathToFileURL(resolve(root, specifier)).href;
    return await import(url) as Record<string, unknown>;
  }
  const require = createRequire(join(root, "package.json"));
  return await import(pathToFileURL(require.resolve(specifier)).href) as Record<string, unknown>;
}

/** BYO key through the existing provider-agnostic seam: `--model-import` loads
 * the host's own ai-SDK model module; otherwise the init-starter default
 * (host-installed `@ai-sdk/anthropic` + ANTHROPIC_API_KEY) is composed. */
export async function resolveRefineModel(options: {
  root: string;
  modelImport?: string;
  env: Record<string, string | undefined>;
}): Promise<LanguageModel> {
  if (options.modelImport !== undefined) {
    let loaded: Record<string, unknown>;
    try {
      loaded = await importHostModule(options.root, options.modelImport);
    } catch (error) {
      throw new Error(
        `could not import ${options.modelImport}: ${error instanceof Error ? error.message : "unknown error"}. `
          + "Pass a runnable JS module (a TypeScript source module needs your runtime to strip types) "
          + "exporting your ai-SDK model as `model` (or default).",
      );
    }
    const model = (loaded["model"] ?? loaded["default"]) as LanguageModel | undefined;
    if (model === undefined) {
      throw new Error(`${options.modelImport} does not export an ai-SDK model as \`model\` (or default)`);
    }
    return model;
  }

  const apiKey = options.env["ANTHROPIC_API_KEY"]?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      "no model configured: set ANTHROPIC_API_KEY (with @ai-sdk/anthropic installed), "
        + "or pass --model-import <specifier> pointing at a module that exports your ai-SDK `model`.",
    );
  }
  let anthropic: { createAnthropic(config: { apiKey: string }): (model: string) => LanguageModel };
  try {
    anthropic = await importHostModule(options.root, "@ai-sdk/anthropic") as never;
  } catch {
    throw new Error(
      "ANTHROPIC_API_KEY is set but @ai-sdk/anthropic is not installed in this app; "
        + "install it (`npm install @ai-sdk/anthropic@^3`) or pass --model-import.",
    );
  }
  return anthropic.createAnthropic({ apiKey })(DEFAULT_ANTHROPIC_MODEL);
}

async function defaultInterview(questions: string[]): Promise<string[]> {
  if (!stdin.isTTY) return [];
  const readline = createInterface({ input: stdin, output: stdout });
  const answers: string[] = [];
  try {
    for (const question of questions) {
      const answer = (await readline.question(`${question}\n> `)).trim();
      if (answer !== "") answers.push(answer);
    }
  } finally {
    readline.close();
  }
  return answers;
}

async function defaultConfirm(change: { path: string; diff: string }, output: Output): Promise<boolean> {
  if (!stdin.isTTY) {
    output.error(`skipped ${change.path}; re-run interactively or with --yes to apply it`);
    return false;
  }
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(`Apply ${change.path}? [y/N] `);
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    readline.close();
  }
}

async function writeTranscript(root: string, transcript: RefineTranscript): Promise<string> {
  const stamp = transcript.startedAt.replace(/[:.]/g, "-");
  const path = join(root, ".vendo", "data", "refine", `${stamp}.json`);
  await writeText(path, `${JSON.stringify(transcript, null, 2)}\n`);
  return path;
}

function printRun(result: RefineResult, output: Output): void {
  for (const probe of result.probes) {
    output.log(`probe ${probe.tool}: ${probe.status}`);
    for (const check of probe.checks) {
      output.log(`  ${check.ok ? "ok" : "failed"}: ${check.name} — ${check.detail}`);
    }
  }
  for (const drop of result.dropped) {
    output.error(`dropped ${drop.kind} ${drop.target}: ${drop.reason}`);
  }
}

export async function runRefineCommand(options: RefineCommandOptions): Promise<number> {
  const root = resolve(options.targetDir);
  const output = options.output ?? consoleOutput;
  const env = options.env ?? process.env;

  if (!await exists(join(root, ".vendo", "tools.json"))) {
    output.error("refine needs .vendo/tools.json — run `vendo init` (or `vendo sync`) first");
    return 1;
  }

  let model: LanguageModel;
  try {
    model = options.model ?? await resolveRefineModel({
      root,
      ...(options.modelImport === undefined ? {} : { modelImport: options.modelImport }),
      env,
    });
  } catch (error) {
    output.error(error instanceof Error ? error.message : "model resolution failed");
    return 1;
  }

  let interview = options.asks ?? [];
  if (interview.length === 0 && options.yes !== true) {
    interview = await (options.interview ?? defaultInterview)(INTERVIEW_QUESTIONS);
  }

  let result: RefineResult;
  try {
    result = await runRefine({
      root,
      model,
      interview,
      ...(options.url === undefined ? {} : { url: options.url }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  } catch (error) {
    output.error(error instanceof Error ? error.message : "vendo refine failed");
    return 1;
  }

  printRun(result, output);

  if (result.changes.length === 0) {
    output.log("No changes proposed.");
    const transcriptPath = await writeTranscript(root, result.transcript);
    output.log(`Transcript: ${transcriptPath}`);
    return 0;
  }

  let applied = 0;
  for (const change of result.changes) {
    output.log(`\nProposed change:\n${change.diff}\n`);
    for (const warning of change.warnings) output.error(`warning: ${warning}`);
    const approved = options.yes === true
      || await (options.confirm ?? ((candidate) => defaultConfirm(candidate, output)))(change);
    if (approved) {
      await writeText(join(root, ...change.path.split("/")), change.after);
      applied += 1;
      output.log(`wrote ${change.path}`);
    } else {
      output.error(`skipped ${change.path}; run \`vendo refine\` again to re-propose`);
    }
    result.transcript.decisions.push({ path: change.path, applied: approved });
  }

  const transcriptPath = await writeTranscript(root, result.transcript);
  output.log(`\nApplied ${applied} of ${result.changes.length} proposed change(s). Transcript: ${transcriptPath}`);
  if (applied > 0) {
    output.log("Review the diffs with `git diff .vendo` and commit them; the registry loads capabilities and overrides on the next boot.");
  }
  return 0;
}
