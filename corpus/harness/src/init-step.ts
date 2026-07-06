import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRunContext, type CorpusRunContext } from "./run-context.js";

export interface InitStepRepo {
  name: string;
}

export interface InitStepArtifacts {
  log: string;
  diff: string;
  tokenCost?: string;
}

export interface InitStepResult {
  repoDir: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  artifacts: InitStepArtifacts;
}

export interface RunVendoInitStepOptions {
  context?: CorpusRunContext;
  cliCommand?: string;
  cliArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  gitBin?: string;
  localVendoDir?: string;
  skipLlm?: boolean;
}

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  combined: string;
}

const defaultWorkspaceRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const defaultCliBin = path.join(defaultWorkspaceRoot, "packages/vendo-cli/dist/cli.js");

function defaultCliInvocation(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [defaultCliBin],
  };
}

function initLogPaths(logsDir: string): InitStepArtifacts {
  return {
    log: path.join(logsDir, "init.log"),
    diff: path.join(logsDir, "init.diff"),
    tokenCost: path.join(logsDir, "init.token-cost.log"),
  };
}

function initArgs(repoDir: string, options: RunVendoInitStepOptions): string[] {
  const args = ["init", repoDir];
  if (options.skipLlm !== false) args.push("--skip-llm");
  if (options.force) args.push("--force");
  if (options.localVendoDir) args.push("--local", options.localVendoDir);
  return args;
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let combined = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      combined += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      combined += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, combined }));
  });
}

function commandOutput(result: CommandResult): string {
  return (result.stderr || result.stdout).trim();
}

async function checkedCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const result = await runCommand(command, args, cwd, env);
  if (result.code !== 0) {
    const output = commandOutput(result);
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result;
}

function extractTokenCostLines(log: string): string[] {
  return log
    .split(/\r?\n/)
    .filter((line) => /\b(tokens?|cost)\b/i.test(line));
}

async function captureGitDiff(repoDir: string, logsDir: string, gitBin: string, env: NodeJS.ProcessEnv): Promise<string> {
  const indexFile = path.join(logsDir, "init.diff.index");
  const gitEnv = { ...env, GIT_INDEX_FILE: indexFile };

  try {
    await rm(indexFile, { force: true });
    await checkedCommand(gitBin, ["read-tree", "HEAD"], repoDir, gitEnv);
    await checkedCommand(gitBin, ["add", "-A", "--", "."], repoDir, gitEnv);
    const diff = await checkedCommand(gitBin, ["diff", "--cached", "--no-ext-diff", "--binary", "HEAD", "--"], repoDir, gitEnv);
    return diff.stdout;
  } catch (error) {
    return `Unable to capture git diff: ${error instanceof Error ? error.message : String(error)}\n`;
  } finally {
    await rm(indexFile, { force: true });
  }
}

export async function runVendoInitStep(
  repo: InitStepRepo,
  options: RunVendoInitStepOptions = {},
): Promise<InitStepResult> {
  const context = options.context ?? createRunContext();
  const repoDir = context.repoDir(repo.name);
  const logsDir = context.logsDir(repo.name);
  const artifacts = initLogPaths(logsDir);
  const invocation = defaultCliInvocation();
  const cliCommand = options.cliCommand ?? invocation.command;
  const cliArgs = [...(options.cliArgs ?? invocation.args), ...initArgs(repoDir, options)];
  const env = {
    ...process.env,
    VENDO_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    ...options.env,
  };

  await mkdir(logsDir, { recursive: true });
  const startedAt = Date.now();
  const result = await runCommand(cliCommand, cliArgs, defaultWorkspaceRoot, env);
  const durationMs = Date.now() - startedAt;
  await writeFile(artifacts.log, result.combined);

  const tokenCostLines = extractTokenCostLines(result.combined);
  if (tokenCostLines.length > 0 && artifacts.tokenCost) {
    await writeFile(artifacts.tokenCost, `${tokenCostLines.join("\n")}\n`);
  } else if (artifacts.tokenCost) {
    await rm(artifacts.tokenCost, { force: true });
    delete artifacts.tokenCost;
  }

  const diff = await captureGitDiff(repoDir, logsDir, options.gitBin ?? "git", env);
  await writeFile(artifacts.diff, diff);

  return {
    repoDir,
    exitCode: result.code,
    signal: result.signal,
    durationMs,
    artifacts,
  };
}
